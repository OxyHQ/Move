/** Types shared between the frontend and backend of Oxy Move. */

/** Response shape of the backend health check. */
export interface HealthResponse {
  status: 'ok';
  service: string;
}

/**
 * The platforms Move can read from. A closed set: the database CHECKs on
 * `migration_jobs.platform` render from this tuple, so adding one is a
 * migration, not a string.
 */
export const MIGRATION_PLATFORMS = ['mastodon', 'bluesky'] as const;
export type MigrationPlatform = (typeof MIGRATION_PLATFORMS)[number];

export function isMigrationPlatform(value: unknown): value is MigrationPlatform {
  return typeof value === 'string' && (MIGRATION_PLATFORMS as readonly string[]).includes(value);
}

/** Platforms the product shows as "coming soon". Not accepted by `POST /jobs`. */
export const UPCOMING_PLATFORMS = ['threads', 'instagram', 'x', 'medium', 'substack'] as const;
export type UpcomingPlatform = (typeof UPCOMING_PLATFORMS)[number];

export const JOB_STATUSES = [
  'queued',
  'running',
  'paused',
  'done',
  'failed',
  'cancelled',
  'undone',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** The statuses that hold the one-active-job-per-user-and-platform slot. */
export const ACTIVE_JOB_STATUSES = [
  'queued',
  'running',
  'paused',
] as const satisfies readonly JobStatus[];

export const PHASE_NAMES = ['profile', 'graph', 'content'] as const;
export type PhaseName = (typeof PHASE_NAMES)[number];

export const PHASE_STATUSES = ['pending', 'running', 'done', 'skipped'] as const;
export type PhaseStatus = (typeof PHASE_STATUSES)[number];

export interface PhaseState {
  status: PhaseStatus;
  /** Why a phase is skipped, as a stable machine code. */
  reason?: string;
}

export type JobPhases = Record<PhaseName, PhaseState>;

export interface JobCounters {
  /** Source items read (every item the source yielded, before filtering). */
  read: number;
  /** Items Mention created. */
  created: number;
  /** Items Mention already had (idempotent resend or adoption). */
  existing: number;
  /** Items Mention refused. */
  failed: number;
  /** Items filtered out (replies to others, boosts when off, non-public). */
  skipped: number;
  /** Children held back until their parent exists. */
  deferred: number;
  /** Media files copied into Oxy. */
  mediaUploaded: number;
  /** Followed accounts read from the source. */
  followsRead: number;
  /** Followed accounts resolved to an Oxy user id. */
  followsResolved: number;
}

export interface JobOptions {
  /** Import posts and articles into Mention. Default true. */
  content: boolean;
  /** Build the follow plan. Default true. */
  graph: boolean;
  /** Build the profile plan. Default true. */
  profile: boolean;
  /** Include boosts/reposts (as a link to the original). Default false. */
  includeBoosts: boolean;
  /** Include replies to OTHER people. Default false; self-threads are always kept. */
  includeRepliesToOthers: boolean;
}

export const DEFAULT_JOB_OPTIONS: JobOptions = {
  content: true,
  graph: true,
  profile: true,
  includeBoosts: false,
  includeRepliesToOthers: false,
};

/** The profile fields the CLIENT applies with the user's own Oxy session. */
export interface ProfilePlan {
  displayName?: string;
  bio?: string;
  /** Oxy file id of the avatar Move already copied into the user's files. */
  avatarFileId?: string;
  links?: string[];
}

/** The follows the CLIENT applies with the user's own Oxy session. */
export interface GraphPlan {
  /** Oxy user ids to follow, in batches of at most {@link FOLLOW_BATCH_SIZE}. */
  followBatches: string[][];
  /** Followed accounts Oxy could not resolve (counted, not listed). */
  unresolved: number;
  /** True when the source hides its follow list (Mastodon `hide_collections`). */
  hidden: boolean;
}

export const FOLLOW_BATCH_SIZE = 200;

/**
 * The blocks the CLIENT applies with the user's own Oxy session. Only sources
 * whose block list is public have one: Bluesky block records are public repo
 * records; Mastodon's block list needs the user's token, which Oxy discards.
 */
export interface BlockPlan {
  /** Oxy user ids to block, in batches of at most {@link FOLLOW_BATCH_SIZE}. */
  blockBatches: string[][];
  /** Blocked accounts read from the source. */
  read: number;
  /** Blocked accounts Oxy could not resolve (counted, not listed). */
  unresolved: number;
}

export interface MigrationPlan {
  profile: ProfilePlan | null;
  graph: GraphPlan | null;
  blocks: BlockPlan | null;
}

export interface PlanAck {
  profileApplied?: boolean;
  /** Indexes into `graph.followBatches` the client has applied. */
  followBatchesApplied?: number[];
  /** Indexes into `blocks.blockBatches` the client has applied. */
  blockBatchesApplied?: number[];
}

/** The profile values the client overwrote, as read from the user's own session. */
export interface ProfileSnapshot {
  displayName?: string;
  bio?: string;
  /** Oxy file id. Absent when there was none (an avatar cannot be cleared back). */
  avatar?: string;
  links?: string[];
}

/**
 * What the client must know to reverse its plan on ANY device, recorded BEFORE
 * each write. Every fact is first-write-wins: a resumed run that re-reads the
 * profile or the follow status after Move already wrote would record Move's own
 * work as the user's.
 */
export interface PlanUndoFacts {
  profileBefore?: ProfileSnapshot;
  /** Follow batch index → targets the user ALREADY followed before Move. */
  alreadyFollowing?: Record<string, string[]>;
  /** Block batch index → targets the user ALREADY blocked before Move. */
  alreadyBlocked?: Record<string, string[]>;
}

/** `POST /jobs/:id/plan/ack`: what was applied, and the facts to undo it. */
export interface PlanAckRequest extends PlanAck, PlanUndoFacts {}

/** `GET /jobs/:id/plan`. */
export interface PlanResponse {
  plan: MigrationPlan;
  ack: PlanAck | null;
  undoFacts: PlanUndoFacts | null;
}

export interface MigrationJobView {
  id: string;
  platform: MigrationPlatform;
  linkedAccountId: string;
  sourceActor: string;
  sourceHandle: string | null;
  status: JobStatus;
  phases: JobPhases;
  counters: JobCounters;
  options: JobOptions;
  error: string | null;
  pausedUntil: string | null;
  planAck: PlanAck | null;
  /**
   * The last undo: posts Mention deleted, and posts it FAILED to delete. With
   * `failed > 0` the job stays retryable (`DELETE /jobs/:id` again).
   */
  undo: { deleted: number; failed: number } | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface MigrationPreview {
  platform: MigrationPlatform;
  sourceActor: string;
  handle: string;
  profile: {
    displayName?: string;
    bio?: string;
    avatarUrl?: string;
  };
  counts: {
    posts?: number;
    following?: number;
    followers?: number;
  };
  newestAt?: string;
  oldestAt?: string;
  /** True when the source hides its follow list. */
  graphHidden: boolean;
}

export interface PlatformInfo {
  id: MigrationPlatform | UpcomingPlatform;
  status: 'available' | 'soon';
  /** What Move brings over from this platform. */
  brings: Array<'profile' | 'graph' | 'posts' | 'articles'>;
}

/** Socket.IO event the backend emits to `user:<id>` as a job advances. */
export const MIGRATION_PROGRESS_EVENT = 'migration:progress';
