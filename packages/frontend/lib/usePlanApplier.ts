import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxy.so/services';
import type { MigrationJobView } from '@move/shared-types';
import { queryKeys, useMoveApi } from './moveApiContext';
import { applyPlan, type PlanDeps, type PlanProgress } from './planApplier';

export type ApplierState =
  | { kind: 'idle' }
  | { kind: 'applying'; progress: PlanProgress | null }
  | { kind: 'done'; progress: PlanProgress }
  | { kind: 'error'; progress: PlanProgress | null };

/** The Oxy SDK + Move API the plan runs against (no device storage: the backend is the record). */
export function usePlanDeps(): PlanDeps {
  const api = useMoveApi();
  const { oxyServices } = useOxy();
  return useMemo(() => ({ api, sdk: oxyServices }), [api, oxyServices]);
}

/**
 * Applies the job's plan with the user's session whenever the backend reports
 * that a phase finished building it, and on mount — which is what makes a
 * migration resumable after the app was closed: the ack says what is left.
 */
export function usePlanApplier(job: MigrationJobView | undefined) {
  const deps = usePlanDeps();
  const queryClient = useQueryClient();
  const [state, setState] = useState<ApplierState>({ kind: 'idle' });
  const running = useRef(false);
  const again = useRef(false);

  const jobId = job?.id;
  const applicable = !!job && job.status !== 'cancelled' && job.status !== 'undone';
  // Re-run when a plan-building phase settles.
  const trigger = job ? `${job.phases.profile.status}/${job.phases.graph.status}/${job.status}` : '';

  const run = useCallback(async () => {
    if (!jobId) return;
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    let last: PlanProgress | null = null;
    try {
      do {
        again.current = false;
        setState({ kind: 'applying', progress: last });
        last = await applyPlan(deps, jobId, (progress) => {
          last = progress;
          setState({ kind: 'applying', progress });
        });
      } while (again.current);
      setState({ kind: 'done', progress: last });
      void queryClient.invalidateQueries({ queryKey: queryKeys.job(jobId) });
    } catch {
      setState({ kind: 'error', progress: last });
    } finally {
      running.current = false;
    }
  }, [deps, jobId, queryClient]);

  useEffect(() => {
    if (applicable) void run();
  }, [applicable, trigger, run]);

  return { state, retry: run };
}
