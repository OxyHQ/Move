import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import { ACTIVE_JOB_STATUSES, MIGRATION_PROGRESS_EVENT, type MigrationJobView } from '@move/shared-types';
import { API_URL } from './config';
import { queryKeys, useMoveApi } from './moveApiContext';

/** Polling while the socket is down; a slow safety net while it is up. */
const POLL_WITHOUT_SOCKET_MS = 3_000;
const POLL_WITH_SOCKET_MS = 20_000;

export function isActive(job: Pick<MigrationJobView, 'status'> | undefined): boolean {
  return !!job && (ACTIVE_JOB_STATUSES as readonly string[]).includes(job.status);
}

/**
 * Live progress of one job: the backend pushes `migration:progress` to
 * `user:<id>` over Socket.IO (authenticated with the Oxy access token), and
 * `GET /jobs/:id` is polled as the fallback and the source of truth.
 */
export function useJob(jobId: string) {
  const api = useMoveApi();
  const queryClient = useQueryClient();
  const { oxyServices } = useOxy();
  const [socketConnected, setSocketConnected] = useState(false);

  const query = useQuery({
    queryKey: queryKeys.job(jobId),
    queryFn: () => api.get(jobId),
    refetchInterval: (q) =>
      isActive(q.state.data) ? (socketConnected ? POLL_WITH_SOCKET_MS : POLL_WITHOUT_SOCKET_MS) : false,
  });

  const active = isActive(query.data);

  useEffect(() => {
    if (!active) return undefined;
    const socket = io(API_URL, {
      auth: (cb) => cb({ token: oxyServices.session.accessToken }),
      transports: ['websocket', 'polling'],
    });
    socket.on('connect', () => setSocketConnected(true));
    socket.on('disconnect', () => setSocketConnected(false));
    socket.on(MIGRATION_PROGRESS_EVENT, (view: MigrationJobView) => {
      queryClient.setQueryData(queryKeys.job(view.id), view);
    });
    // A rotated token re-runs the handshake with the fresh one.
    const unsubscribe = oxyServices.session.onChange((token) => {
      if (token && !socket.connected) socket.connect();
    });
    return () => {
      unsubscribe();
      socket.disconnect();
      setSocketConnected(false);
    };
  }, [active, oxyServices, queryClient]);

  return query;
}
