/**
 * Runtime seam for the Socket.IO server, so the pipeline can push progress to
 * `user:<id>` without importing the server entrypoint (Mention's
 * `runtime/socketServer.ts` pattern). Unset in tests and one-shots: emitting is
 * then a no-op, and `GET /jobs/:id` remains the source of truth.
 */

import type { Server as SocketIOServer } from 'socket.io';
import { MIGRATION_PROGRESS_EVENT } from '@move/shared-types';
import type { ProgressSink } from '../pipeline/runner';
import { toJobView } from '../pipeline/jobService';

let io: SocketIOServer | null = null;

export function setRuntimeSocketServer(server: SocketIOServer): void {
  io = server;
}

export const socketProgressSink: ProgressSink = {
  emit(oxyUserId, job) {
    io?.to(`user:${oxyUserId}`).emit(MIGRATION_PROGRESS_EVENT, toJobView(job));
  },
};
