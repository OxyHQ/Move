// Provenance: copied from OxyHQ/Mention packages/backend/src/runtime/gracefulShutdown.ts
// @ f5ad90c9bbf6cc9f7f9b93e1378c4b011031812b (origin/main). Same two-phase drain and
// deadline; Mention's presence registry, outbox dispatchers, user-cache
// subscriber and socket Redis adapter are not part of Move.

import type http from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
import { closePostgres } from '../db/postgres';
import { shutdownQueues } from '../queue/workers';
import { closeRedis } from '../utils/redis';
import { logger } from '../utils/logger';
import { markRuntimeShuttingDown } from '../utils/runtimeHealth';

/** Hard ceiling on the whole drain; open connections are then forced closed. */
const SHUTDOWN_DEADLINE_MS = 10_000;

/**
 * Install the SIGTERM/SIGINT drain. Readiness drops and HTTP stops accepting at
 * once; the queue worker then stops while Postgres and Redis are still open (a
 * migration interrupted here resumes from its checkpoint on another task), and
 * only then do HTTP, sockets, Redis and Postgres close.
 */
export interface GracefulShutdownDeps {
  server: http.Server;
  io: SocketIOServer;
  /**
   * Stops the platform-activity publisher: flushes the last traffic aggregate
   * and sends the `removed` heartbeat so this instance leaves the dashboard
   * registry now rather than at lease expiry. Runs LAST, after HTTP and sockets
   * have drained, so their final requests are still counted.
   */
  stopActivity?: () => Promise<void>;
}

export function registerGracefulShutdown({ server, io, stopActivity }: GracefulShutdownDeps): void {
  let isShuttingDown = false;

  const gracefulShutdown = (signal: string): void => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    markRuntimeShuttingDown();
    logger.info(`Received ${signal} - shutting down gracefully`);

    const httpClosed = new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close((error) => {
        if (error) logger.warn('HTTP server close reported an error', error);
        resolve();
      });
    });

    const hardTimeout = setTimeout(() => {
      logger.warn('Shutdown timed out - forcing open connections closed');
      server.closeAllConnections();
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    hardTimeout.unref();

    void (async () => {
      await shutdownQueues().catch((error) =>
        logger.error('Error shutting down the migration queue', error),
      );
      const socketsClosed = new Promise<void>((resolve) => io.close(() => resolve()));
      await Promise.allSettled([httpClosed, socketsClosed, closeRedis(), closePostgres()]);
      await stopActivity?.().catch((error) =>
        logger.warn('Platform activity publisher did not stop cleanly', error),
      );
      clearTimeout(hardTimeout);
      logger.info('HTTP, sockets, queue, Redis and PostgreSQL closed');
      process.exit(0);
    })();
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}
