/**
 * Typed client for Move's own backend (`packages/backend/src/routes/jobs.routes.ts`).
 * Built over the SDK's linked client (`oxyServices.createLinkedClient`), which
 * carries the user's Oxy session; see `MoveApiProvider`.
 */

import type {
  JobOptions,
  MigrationJobView,
  MigrationPlatform,
  MigrationPreview,
  PlanAckRequest,
  PlanResponse,
  PlatformInfo,
} from '@move/shared-types';

/** The slice of the SDK's `HttpService` this client needs (also what tests fake). */
export interface MoveHttp {
  get<T>(url: string): Promise<T>;
  post<T>(url: string, data?: unknown): Promise<T>;
  delete<T>(url: string): Promise<T>;
}

/** `DELETE /jobs/:id`: what the backend did, and what the client needs to reverse the rest. */
export interface UndoResult extends PlanResponse {
  job: MigrationJobView;
  deleted: number;
  failed: number;
}

export interface MoveApi {
  platforms(): Promise<PlatformInfo[]>;
  preview(platform: MigrationPlatform, linkedAccountId: string): Promise<MigrationPreview>;
  create(platform: MigrationPlatform, linkedAccountId: string, options: Partial<JobOptions>): Promise<MigrationJobView>;
  list(): Promise<MigrationJobView[]>;
  get(jobId: string): Promise<MigrationJobView>;
  plan(jobId: string): Promise<PlanResponse>;
  ack(jobId: string, ack: PlanAckRequest): Promise<MigrationJobView>;
  cancel(jobId: string): Promise<MigrationJobView>;
  undo(jobId: string): Promise<UndoResult>;
}

const job = (id: string) => `/jobs/${encodeURIComponent(id)}`;

export function createMoveApi(http: MoveHttp): MoveApi {
  return {
    platforms: async () => (await http.get<{ platforms: PlatformInfo[] }>('/platforms')).platforms,
    preview: async (platform, linkedAccountId) =>
      (await http.post<{ preview: MigrationPreview }>('/jobs', { platform, linkedAccountId, dryRun: true })).preview,
    create: async (platform, linkedAccountId, options) =>
      (await http.post<{ job: MigrationJobView }>('/jobs', { platform, linkedAccountId, options })).job,
    list: async () => (await http.get<{ jobs: MigrationJobView[] }>('/jobs')).jobs,
    get: async (id) => (await http.get<{ job: MigrationJobView }>(job(id))).job,
    plan: (id) => http.get<PlanResponse>(`${job(id)}/plan`),
    ack: async (id, ack) => (await http.post<{ job: MigrationJobView }>(`${job(id)}/plan/ack`, ack)).job,
    cancel: async (id) => (await http.post<{ job: MigrationJobView }>(`${job(id)}/cancel`)).job,
    undo: (id) => http.delete<UndoResult>(job(id)),
  };
}

/**
 * The machine code of a failed request: Move's backend answers `{ error: '<code>' }`,
 * which the SDK keeps verbatim on `response.data`; Oxy's own errors carry `code`.
 */
export function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const response = (error as { response?: { data?: unknown } }).response;
  const data = response?.data;
  if (data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
    return (data as { error: string }).error;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
