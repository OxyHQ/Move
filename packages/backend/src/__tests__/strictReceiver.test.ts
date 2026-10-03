/** Real installed receiver and loopback authority; no live credentials/grants. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { OxyServer, createOxyAuthMiddleware, type OxyAuthenticatedRequest } from '@oxy.so/core/server';

const keys = generateKeyPairSync('ed25519');
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'move-fixture', use: 'sig', alg: 'EdDSA' };
const now = () => Math.floor(Date.now() / 1000);
function token(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: jwk.kid, typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iat: now(), exp: now() + 300, iss: 'oxy-auth', aud: 'oxy-api', ...claims })).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${sign(null, Buffer.from(input), keys.privateKey).toString('base64url')}`;
}
const serviceClaims = { type: 'service', appId: 'move-fixture', appName: 'Move', credentialId: 'wl_move-fixture', ownerAccountId: 'owner-fixture', environment: 'production', tier: 'internal', scopes: ['linked-accounts:read'] };
let revoked = false;
let base: string;
let validationCalls = 0;
let grantCalls = 0;
let host: http.Server;
let sockets: Server;
let authority: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  authority = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/.well-known/jwks.json') return Response.json({ keys: [jwk] });
    if (url.pathname === '/session/validate/session-fixture') {
      validationCalls++;
      return Response.json(revoked ? { valid: false } : { valid: true, user: { id: 'user-fixture', username: 'fixture' } });
    }
    if (url.pathname === '/auth/service-token') {
      return Response.json({ token: token({ ...serviceClaims, appId: 'verifier-fixture', credentialId: 'verifier-fixture' }), expiresIn: 300, appName: 'Verifier fixture' });
    }
    if (url.pathname === '/internal/service-acting-as/verify') {
      grantCalls++;
      expect(url.searchParams.get('appId')).toBe(serviceClaims.appId);
      expect(url.searchParams.get('userId')).toBe('user-fixture');
      expect(url.searchParams.get('credentialId')).toBe(serviceClaims.credentialId);
      expect(url.searchParams.get('ownerAccountId')).toBe(serviceClaims.ownerAccountId);
      expect(url.searchParams.get('environment')).toBe(serviceClaims.environment);
      return Response.json({ authorized: false, scopes: [], epoch: '1' });
    }
    return Response.json({ error: 'NO_FIXTURE_AUTHORITY' }, { status: 403 });
  } });
  const oxy = new OxyServer({ baseURL: `http://127.0.0.1:${authority.port}`, serviceAuth: { apiKey: 'fixture-only', apiSecret: 'fixture-only' } });
  const app = express();
  app.get('/private', createOxyAuthMiddleware(oxy), (request, response) => {
    response.json({ userId: (request as OxyAuthenticatedRequest).userId });
  });
  host = http.createServer(app);
  sockets = new Server(host);
  sockets.use(oxy.middleware.socket());
  sockets.on('connection', (socket) => {
    const user = (socket as typeof socket & { user?: { id: string } }).user;
    socket.join(`user:${user?.id}`);
    socket.emit('identity', { userId: user?.id, rooms: [...socket.rooms].filter((room) => room.startsWith('user:')) });
  });
  await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
  const address = host.address();
  if (address === null || typeof address === 'string') throw new Error('No loopback listener');
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { await sockets?.close(); authority?.stop(true); });

async function socketIdentity(bearer: string) {
  const socket = connect(base, { auth: { token: bearer }, transports: ['websocket'], reconnection: false, timeout: 1000 });
  try {
    return await new Promise((resolve, reject) => {
      socket.once('identity', resolve);
      socket.once('connect_error', reject);
    });
  } finally { socket.disconnect(); }
}

describe('Move installed receiver versus strict-format claims', () => {
  test('human session reaches HTTP and socket room; claim mismatch and withdrawal refuse', async () => {
    const human = token({ userId: 'user-fixture', sessionId: 'session-fixture', type: 'access' });
    expect((await fetch(`${base}/private`, { headers: { Authorization: `Bearer ${human}` } })).status).toBe(200);
    expect(await socketIdentity(human)).toEqual({ userId: 'user-fixture', rooms: ['user:user-fixture'] });
    const other = token({ userId: 'other-fixture', sessionId: 'session-fixture', type: 'access' });
    expect((await fetch(`${base}/private`, { headers: { Authorization: `Bearer ${other}` } })).status).toBe(401);
    await expect(socketIdentity(other)).rejects.toThrow('Session user mismatch');
    revoked = true;
    expect((await fetch(`${base}/private`, { headers: { Authorization: `Bearer ${human}` } })).status).toBe(401);
    await expect(socketIdentity(human)).rejects.toThrow('Session validation failed');
    expect(validationCalls).toBe(6);
  });
  test('signed internal service token plus user header cannot enter the human API without delegated authority', async () => {
    const response = await fetch(`${base}/private`, { headers: { Authorization: `Bearer ${token(serviceClaims)}`, 'X-Oxy-User-Id': 'user-fixture' } });
    // This is the strict contract; core4.0's internal-tier bypass makes this RED.
    expect(response.status).toBeGreaterThanOrEqual(400);
    // Real verifier HTTP path must be reached; no positive grant is supplied.
    expect(grantCalls).toBe(1);
  });
  test('app-only service token is not a human, and service token cannot open a human socket', async () => {
    const bearer = token(serviceClaims);
    expect((await fetch(`${base}/private`, { headers: { Authorization: `Bearer ${bearer}` } })).status).toBe(401);
    await expect(socketIdentity(bearer)).rejects.toThrow('Invalid token payload');
  });
});
