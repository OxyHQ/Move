// Provenance: copied from OxyHQ/Mention packages/backend/src/routes/health.routes.ts
// @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b (origin/main), merged with the
// create-oxy-app scaffold's `/health` + `/ready`. The migration-ledger check is
// the scaffold's (`assertMigrationsCurrent`), a real read on every probe.

import { Router, type Response } from 'express';
import type { HealthResponse } from '@move/shared-types';
import { assertMigrationsCurrent, checkPostgresHealth } from '../db/postgres';
import { isRedisConfigured, isRedisReady } from '../utils/redis';
import { getRuntimePhase } from '../utils/runtimeHealth';
import { logger } from '../utils/logger';

const router = Router();

/** Liveness: a process that can answer is alive. Draining is readiness's job. */
router.get('/health', (_req, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ status: 'ok', service: 'move-backend' } satisfies HealthResponse);
});

/**
 * Readiness — what the ALB target group probes. Ready only when this task is
 * not draining, Postgres answers, AND every migration this build ships is
 * applied. Redis is reported but does not gate.
 */
router.get('/ready', async (_req, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  const phase = getRuntimePhase();
  const postgresReady = await checkPostgresHealth();
  let migrationsCurrent = false;
  if (postgresReady) {
    try {
      await assertMigrationsCurrent();
      migrationsCurrent = true;
    } catch (error) {
      logger.warn('Not ready — migrations are not current', error);
    }
  }
  const isReady = phase === 'ready' && postgresReady && migrationsCurrent;
  res.status(isReady ? 200 : 503).json({
    status: isReady ? 'ready' : 'not_ready',
    phase,
    dependencies: {
      postgres: postgresReady ? 'ready' : 'unavailable',
      migrations: migrationsCurrent ? 'ready' : 'pending',
      redis: !isRedisConfigured() ? 'disabled' : isRedisReady() ? 'ready' : 'degraded',
    },
  });
});

export default router;
