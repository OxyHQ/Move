import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import {
  OxyServer,
  createOxyAuthMiddleware,
  createOxyCors,
  createOxyRateLimit,
} from '@oxy.so/core/server';
import { config } from './src/config';
import { closePostgres, connectPostgres } from './src/db/postgres';
import healthRoutes from './src/routes/health.routes';
import { createJobsRouter } from './src/routes/jobs.routes';
import { startPlatformActivity } from './src/runtime/platformActivity';
import { setRuntimeSocketServer } from './src/runtime/socketServer';
import { registerGracefulShutdown } from './src/runtime/gracefulShutdown';
import { createJobService, createPipelineDeps } from './src/runtime/pipelineDeps';
import { scheduleStalledSweep } from './src/queue/queues';
import { startWorkers } from './src/queue/workers';
import { isRuntimeReady, markRuntimeReady } from './src/utils/runtimeHealth';
import { logger } from './src/utils/logger';

// The Oxy apex family (*.oxy.so, including move.oxy.so) is allowed by
// createOxyCors; only the Expo dev server's origins are listed.
const APP_ORIGINS = ['http://localhost:8081', 'http://localhost:19006'];

// Verifies users' sessions; Move's own service identity is `getServiceOxyClient()`.
const oxy = new OxyServer({ baseURL: config.oxyApiUrl });

// Oxy ecosystem telemetry (traffic + infrastructure heartbeat for the oxy.so
// dashboard). Started here, in the process entry, so a test that builds routes
// starts no publisher; and it publishes only on ECS (workload identity), so a
// local checkout starts none either. `undefined` everywhere else.
const activity = startPlatformActivity(isRuntimeReady);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
// Before every route, the probes included, so the observed traffic is all of it.
if (activity) app.use(activity.observeHttp);
app.use(express.json({ limit: '256kb' }));
app.use(createOxyCors({ appOrigins: APP_ORIGINS }));
// Probes first, unauthenticated and unthrottled.
app.use(healthRoutes);

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: APP_ORIGINS, methods: ['GET', 'POST'], credentials: true },
});

// Only authenticated sockets connect, and the room is the AUTHENTICATED user's
// id, never a client-supplied one: `migration:progress` goes to `user:<id>`.
io.use(oxy.middleware.socket());
io.on('connection', (socket: Socket & { user?: { id: string } }) => {
  const userId = socket.user?.id;
  if (!userId) {
    socket.disconnect(true);
    return;
  }
  activity?.observeSocket(socket);
  void socket.join(`user:${userId}`);
});

async function boot(): Promise<void> {
  await connectPostgres();
  const pipeline = createPipelineDeps();

  app.use(createOxyRateLimit(oxy));
  app.use(createJobsRouter(createJobService(pipeline), createOxyAuthMiddleware(oxy)));

  setRuntimeSocketServer(io);
  startWorkers(pipeline, config.workerConcurrency);
  await scheduleStalledSweep();

  markRuntimeReady();
  registerGracefulShutdown({
    server,
    io,
    stopActivity: activity ? () => activity.stop() : undefined,
  });
  server.listen(config.runtime.port, () =>
    logger.info(`Oxy Move backend listening on :${config.runtime.port}`),
  );
}

void boot().catch(async (error) => {
  logger.error('Boot failed', error);
  await activity?.stop().catch(() => undefined);
  await closePostgres().catch(() => undefined);
  process.exit(1);
});

// NOTHING is exported from this entrypoint: under Bun, an entry module whose
// exports look like a server config is also handed to `Bun.serve()`, which
// crashes the compiled server at startup (docs/scaffold-issues.md #1).
