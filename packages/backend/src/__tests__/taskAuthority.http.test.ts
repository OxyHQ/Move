import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { OxyServer } from '@oxy.so/core/server';
import { taskAuthority } from '../utils/taskAuthority';

let api: ReturnType<typeof Bun.serve>;
let oxy: OxyServer;
let wrongAccount = false;
let revoked = false;
const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
const session = {
  requesterToken: 'original-session',
  actorAccountId: 'human',
  effectiveAccountId: 'organization',
};
beforeAll(() => {
  const now = Math.floor(Date.now() / 1000);
  const token = `e30.${Buffer.from(JSON.stringify({ iat: now, exp: now + 300, authority: 'first_party' })).toString('base64url')}.fixture`;
  api = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/challenge')) return Response.json({ nonce: 'fixture' });
      if (path === '/auth/service-token/workload') {
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.protocolVersion).toBe(2);
        expect(body).not.toHaveProperty('scopes');
        return Response.json({ token, expiresIn: 300 });
      }
      expect(request.headers.get('authorization')).toBe(`Bearer ${token}`);
      if (request.method === 'DELETE') {
        requests.push({ path, body: {} });
        return Response.json({});
      }
      const body = (await request.json()) as Record<string, unknown>;
      requests.push({ path, body });
      if (revoked || body.subjectToken !== session.requesterToken)
        return Response.json({ error: 'requester_revoked' }, { status: 403 });
      return Response.json({
        task: {
          id: 'original-task',
          requesterAccountId: 'human',
          effectiveAccountId: wrongAccount ? 'another-account' : 'organization',
        },
      });
    },
  });
  oxy = new OxyServer({
    baseURL: api.url.origin,
    workloadCredentials: async () => ({
      AccessKeyId: 'ASIA_TEST',
      SecretAccessKey: 'fixture',
      Token: 'temporary',
    }),
  });
});
beforeEach(() => {
  requests.length = 0;
  wrongAccount = false;
  revoked = false;
});
afterAll(() => {
  oxy.dispose();
  api.stop(true);
});
test('real shared transport creates a managed-account task without equating operator and effective account', async () => {
  expect(await taskAuthority(oxy).create(session, 'job-id')).toBe('original-task');
  expect(requests[0]).toMatchObject({
    path: '/capabilities/tasks',
    body: {
      origin: { kind: 'goal', id: 'job-id' },
      actor: { type: 'requester', accountId: 'human' },
      effectiveAccountId: 'organization',
      subjectToken: 'original-session',
    },
  });
  expect(requests[0].body).not.toHaveProperty('scopes');
});
test('mismatched task identity is revoked and never attached to the job', async () => {
  wrongAccount = true;
  await expect(taskAuthority(oxy).create(session, 'job-id')).rejects.toThrow(
    'different requester or account',
  );
  expect(requests[1].path).toBe('/capabilities/tasks/original-task');
});
test('revoked requester cannot be replaced by a service token or job owner', async () => {
  revoked = true;
  await expect(taskAuthority(oxy).create(session, 'job-id')).rejects.toThrow();
  expect(requests).toHaveLength(1);
});
test('undo is a fresh short request bound to the same effective account', async () => {
  await taskAuthority(oxy).create(session, 'undo:job-id', 'request');
  expect(requests[0].body.origin).toEqual({ kind: 'request', id: 'undo:job-id' });
  expect(Date.parse(requests[0].body.expiresAt as string) - Date.now()).toBeLessThanOrEqual(
    15 * 60_000,
  );
});
