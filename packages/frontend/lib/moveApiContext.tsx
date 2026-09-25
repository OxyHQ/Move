import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useOxy } from '@oxy.so/services';
import { API_URL } from './config';
import { createMoveApi, type MoveApi } from './moveApi';

const MoveApiContext = createContext<MoveApi | null>(null);

/**
 * ONE client for Move's backend, linked to the Oxy session (`createLinkedClient`
 * keeps its bearer in lockstep with OxyProvider's and refreshes through it).
 * Must live inside `OxyProvider`.
 */
export function MoveApiProvider({ children }: { children: ReactNode }) {
  const { oxyServices } = useOxy();
  const linked = useMemo(() => oxyServices.createLinkedClient({ baseURL: API_URL }), [oxyServices]);
  useEffect(() => () => linked.dispose(), [linked]);
  const api = useMemo(() => createMoveApi(linked.client), [linked]);
  return <MoveApiContext.Provider value={api}>{children}</MoveApiContext.Provider>;
}

export function useMoveApi(): MoveApi {
  const api = useContext(MoveApiContext);
  if (!api) throw new Error('useMoveApi must be used within <MoveApiProvider>');
  return api;
}

/** React Query keys, in one place so invalidation cannot drift. */
export const queryKeys = {
  platforms: ['platforms'] as const,
  jobs: ['jobs'] as const,
  job: (id: string) => ['jobs', id] as const,
  preview: (platform: string, linkedAccountId: string) => ['preview', platform, linkedAccountId] as const,
  linkedAccounts: ['linked-accounts'] as const,
};
