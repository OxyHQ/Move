/**
 * Redis for Oxy Move: the BullMQ connection and one command client, both
 * ioredis, both lazy. Without `REDIS_URL` (local development) neither exists:
 * jobs run in-process, and the media limiter and the HTTP rate limiter are
 * per-process.
 *
 * BullMQ needs `maxRetriesPerRequest: null` (blocking commands). The command
 * client is the opposite: one retry, so a Redis outage fails a command fast
 * instead of hanging. The media limiter asks only a READY client
 * (`getReadyRedis`) and falls back otherwise; the HTTP rate limiter's store
 * loads its scripts at boot, so a command sent while the client is still
 * connecting waits in the offline queue for the connection, not for an outage.
 */

import IORedis, { type RedisOptions } from 'ioredis';
import { RedisStore, type RedisReply } from 'rate-limit-redis';
import { config } from '../config';
import { logger } from './logger';

let queueConnection: IORedis | null = null;
let commandClient: IORedis | null = null;

export function isRedisConfigured(): boolean {
  return Boolean(config.redisUrl);
}

function connect(name: string, options: RedisOptions): IORedis {
  if (!config.redisUrl) throw new Error('REDIS_URL is not set');
  const client = new IORedis(config.redisUrl, { connectTimeout: 15_000, ...options });
  client.on('error', (error) => logger.warn(`[redis] ${name} connection error`, error));
  return client;
}

export function getQueueConnection(): IORedis {
  queueConnection ??= connect('queue', { maxRetriesPerRequest: null });
  return queueConnection;
}

function getCommandRedis(): IORedis {
  commandClient ??= connect('command', { maxRetriesPerRequest: 1 });
  return commandClient;
}

/** The command client, or null when Redis is not configured or not ready right now. */
export function getReadyRedis(): IORedis | null {
  if (!config.redisUrl) return null;
  const client = getCommandRedis();
  return client.status === 'ready' ? client : null;
}

/**
 * The HTTP rate limiter's shared store (`createOxyRateLimit(oxy, { store })`),
 * so every task counts against one budget per caller; undefined without Redis,
 * which keeps the limiter's in-memory default.
 */
export function createRateLimitStore(): RedisStore | undefined {
  if (!config.redisUrl) return undefined;
  const client = getCommandRedis();
  return new RedisStore({
    prefix: 'move:rl:',
    sendCommand: (command: string, ...args: string[]) =>
      client.call(command, ...args) as Promise<RedisReply>,
  });
}

export function isRedisReady(): boolean {
  return getReadyRedis() !== null;
}

export async function closeRedis(): Promise<void> {
  const clients = [queueConnection, commandClient].filter(
    (client): client is IORedis => client !== null,
  );
  queueConnection = null;
  commandClient = null;
  await Promise.allSettled(clients.map((client) => client.quit()));
}
