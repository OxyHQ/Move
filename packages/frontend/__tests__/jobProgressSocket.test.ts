import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from 'socket.io';
import { OxyServices } from '@oxy.so/core';
import { MIGRATION_PROGRESS_EVENT, type MigrationJobView } from '@move/shared-types';
import { connectJobProgress } from '../lib/jobProgressSocket';

const token = (userId: string, exp = 2_000_000_000) =>
  `e30.${Buffer.from(JSON.stringify({ userId, sessionId: userId, exp })).toString('base64url')}.fixture`;

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Socket condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture() {
  const http = createServer();
  const io = new Server(http);
  const handshakes: string[] = [];
  io.use((socket, next) => {
    handshakes.push(socket.handshake.auth.token);
    next();
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const baseURL = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const oxy = new OxyServices({ baseURL });
  return {
    io,
    oxy,
    baseURL,
    handshakes,
    async close() {
      oxy.dispose();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}

test('connected job socket is cut off on account switch, reconnects with shared refreshed authority and disposes', async () => {
  const f = await fixture();
  const progress: MigrationJobView[] = [];
  let connected = false;
  let ended = 0;
  let dispose = () => {};
  const events = {
    onConnected: (value: boolean) => {
      connected = value;
    },
    onProgress: (view: MigrationJobView) => {
      progress.push(view);
    },
    onContextEnd: () => {
      ended++;
    },
  };
  try {
    f.oxy.session.setAccessToken(token('A', 1));
    let refreshes = 0;
    f.oxy.http.setAuthRefreshHandler(async () => {
      refreshes++;
      return token('A');
    });
    dispose = connectJobProgress(f.oxy, f.baseURL, events);
    await until(() => connected);
    expect(f.handshakes).toEqual([token('A')]);
    expect(refreshes).toBe(1);
    f.io.emit(MIGRATION_PROGRESS_EVENT, { id: 'job-A' });
    await until(() => progress.length === 1);
    f.oxy.session.setAccessToken(token('B'));
    expect(connected).toBe(false);
    expect(ended).toBe(1);
    f.io.emit(MIGRATION_PROGRESS_EVENT, { id: 'stale-A' });
    await until(() => f.io.sockets.sockets.size === 0);
    expect(progress.map((view) => view.id)).toEqual(['job-A']);
    dispose = connectJobProgress(f.oxy, f.baseURL, events);
    await until(() => connected);
    expect(f.handshakes).toEqual([token('A'), token('B')]);
    f.oxy.session.clear();
    expect(connected).toBe(false);
    await until(() => f.io.sockets.sockets.size === 0);
    expect(ended).toBe(2);
    dispose();
    f.oxy.session.setAccessToken(token('C'));
    expect(ended).toBe(2);
  } finally {
    dispose();
    await f.close();
  }
});

test('a pending handshake refresh cannot connect after switch or disposal', async () => {
  for (const change of ['switch', 'dispose'] as const) {
    const f = await fixture();
    let release: (() => void) | undefined;
    let arrived = false;
    let connected = false;
    let dispose = () => {};
    try {
      f.oxy.session.setAccessToken(token('A', 1));
      f.oxy.http.setAuthRefreshHandler(async () => {
        arrived = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return token('A');
      });
      dispose = connectJobProgress(f.oxy, f.baseURL, {
        onConnected: (value) => {
          connected = value;
        },
        onProgress: () => {},
        onContextEnd: () => {},
      });
      await until(() => arrived);
      if (change === 'switch') f.oxy.session.setAccessToken(token('B'));
      else dispose();
      release?.();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(f.handshakes).toEqual([]);
      expect(connected).toBe(false);
      if (change === 'switch') expect(f.oxy.session.userId).toBe('B');
    } finally {
      release?.();
      dispose();
      await f.close();
    }
  }
});
