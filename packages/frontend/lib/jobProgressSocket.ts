import type { OxyServices } from '@oxy.so/core';
import { io } from 'socket.io-client';
import { MIGRATION_PROGRESS_EVENT, type MigrationJobView } from '@move/shared-types';

/** One job-progress subscription, bound to the originating Oxy session context. */
export function connectJobProgress(
  oxy: OxyServices,
  baseURL: string,
  events: {
    onConnected(connected: boolean): void;
    onProgress(view: MigrationJobView): void;
    onContextEnd(): void;
  },
): () => void {
  const linked = oxy.createLinkedClient({ baseURL });
  const epoch = oxy.http.getSessionEpoch();
  const controller = new AbortController();
  const socket = io(baseURL, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    auth: (callback) => {
      void linked.getAccessToken(baseURL, { signal: controller.signal }).then(
        (token) => {
          if (!controller.signal.aborted) callback({ token });
        },
        () => {
          if (!controller.signal.aborted) callback({});
        },
      );
    },
  });
  const unsubscribe = oxy.http.addTokenChangeListener(() => {
    if (oxy.http.getSessionEpoch() === epoch) return;
    dispose();
    events.onContextEnd();
  });
  function dispose(): void {
    if (controller.signal.aborted) return;
    controller.abort();
    unsubscribe();
    socket.removeAllListeners();
    socket.disconnect();
    linked.dispose();
    events.onConnected(false);
  }
  socket.on('connect', () => {
    if (!controller.signal.aborted) events.onConnected(true);
  });
  socket.on('disconnect', () => events.onConnected(false));
  socket.on(MIGRATION_PROGRESS_EVENT, (view: MigrationJobView) => {
    if (!controller.signal.aborted) events.onProgress(view);
  });
  socket.connect();
  return dispose;
}
