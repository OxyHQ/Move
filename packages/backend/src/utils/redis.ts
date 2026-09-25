/**
 * Redis for Oxy Move: the BullMQ connection and one command client, both
 * ioredis, both lazy. Without `REDIS_URL` (local development) neither exists:
 * jobs run in-process and the media limiter is per-process.
 *
 * BullMQ needs `maxRetriesPerRequest: null` (blocking commands). The command
 * client is the opposite: no offline queue and one retry, so a Redis outage
 * fails a limiter call fast and the caller falls back instead of hanging.
 */

import IORedis, { type RedisOptions } from 'ioredis';
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

/** The command client, or null when Redis is not configured or not ready right now. */
export function getReadyRedis(): IORedis | null {
  if (!config.redisUrl) return null;
  commandClient ??= connect('command', { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  return commandClient.status === 'ready' ? commandClient : null;
}

export function isRedisReady(): boolean {
  return getReadyRedis() !== null;
}

export async function closeRedis(): Promise<void> {
  const clients = [queueConnection, commandClient].filter((client): client is IORedis => client !== null);
  queueConnection = null;
  commandClient = null;
  await Promise.allSettled(clients.map((client) => client.quit()));
}
