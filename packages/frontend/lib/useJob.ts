import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services/ui/client';
import { ACTIVE_JOB_STATUSES, type MigrationJobView } from '@move/shared-types';
import { API_URL } from './config';
import { connectJobProgress } from './jobProgressSocket';
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
  const { oxyServices, canUsePrivateApi } = useOxy();
  const [socketConnected, setSocketConnected] = useState(false);
  const [contextRevision, setContextRevision] = useState(0);

  const query = useQuery({
    queryKey: queryKeys.job(jobId),
    queryFn: () => api.get(jobId),
    refetchInterval: (q) =>
      isActive(q.state.data)
        ? socketConnected
          ? POLL_WITH_SOCKET_MS
          : POLL_WITHOUT_SOCKET_MS
        : false,
  });

  const active = isActive(query.data);

  useEffect(() => {
    if (!active || !canUsePrivateApi) return undefined;
    return connectJobProgress(oxyServices, API_URL, {
      onConnected: setSocketConnected,
      onProgress: (view) => queryClient.setQueryData(queryKeys.job(view.id), view),
      onContextEnd: () => setContextRevision(contextRevision + 1),
    });
  }, [active, canUsePrivateApi, oxyServices, queryClient, contextRevision]);

  return query;
}
