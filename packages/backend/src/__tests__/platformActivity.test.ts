import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as realCoreServer from '@oxy.so/core/server';
import {
  isRuntimeReady,
  markRuntimeReady,
  markRuntimeShuttingDown,
  recordReadinessVerdict,
} from '../utils/runtimeHealth';

// Spread the real module so every other export (SsrfRejection, OxyServer, …)
// keeps working for any test file that shares this process.
const canAttestWorkloadIdentity = mock(() => false);
const installFetch = mock(() => undefined);
const createEcosystemTraffic = mock((_options: { service: string; ready?: () => boolean }) => ({
  installFetch,
  observeHttp: () => undefined,
  observeSocket: () => () => undefined,
  stop: async () => undefined,
}));
mock.module('@oxy.so/core/server', () => ({
  ...realCoreServer,
  canAttestWorkloadIdentity,
  createEcosystemTraffic,
}));

// Imported after the mock is registered, so the module binds to the mocks.
let startPlatformActivity: typeof import('../runtime/platformActivity').startPlatformActivity;
beforeAll(async () => {
  ({ startPlatformActivity } = await import('../runtime/platformActivity'));
});

beforeEach(() => {
  canAttestWorkloadIdentity.mockClear();
  createEcosystemTraffic.mockClear();
  installFetch.mockClear();
});

describe('platform activity', () => {
  test('without workload identity (a laptop, CI, a test) no publisher is started', () => {
    canAttestWorkloadIdentity.mockImplementation(() => false);
    expect(startPlatformActivity(() => true)).toBeUndefined();
    expect(createEcosystemTraffic).not.toHaveBeenCalled();
    expect(installFetch).not.toHaveBeenCalled();
  });

  test('on ECS it publishes as `move`, with the readiness callback, and wraps fetch once', () => {
    canAttestWorkloadIdentity.mockImplementation(() => true);
    const ready = () => true;
    const activity = startPlatformActivity(ready);
    expect(activity).toBeDefined();
    expect(createEcosystemTraffic).toHaveBeenCalledTimes(1);
    expect(createEcosystemTraffic.mock.calls[0]![0]).toEqual({ service: 'move', ready });
    expect(installFetch).toHaveBeenCalledTimes(1);
  });
});

describe('synchronous readiness for the heartbeat', () => {
  afterEach(() => recordReadinessVerdict(false));

  test('is not ready until a /ready probe has passed, and not while draining', () => {
    markRuntimeReady();
    recordReadinessVerdict(false);
    expect(isRuntimeReady()).toBe(false);
    recordReadinessVerdict(true);
    expect(isRuntimeReady()).toBe(true);
    markRuntimeShuttingDown();
    expect(isRuntimeReady()).toBe(false);
  });
});
