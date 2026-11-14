import { afterEach, describe, expect, test } from 'bun:test';
import {
  isRuntimeReady,
  markRuntimeReady,
  markRuntimeShuttingDown,
  recordReadinessVerdict,
} from '../utils/runtimeHealth';

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
