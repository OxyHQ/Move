/**
 * The client half of a migration. Oxy accepts profile, follow and block writes
 * only from the user's own session, so the backend builds a PLAN and the app
 * applies it here, acknowledging each step with `POST /jobs/:id/plan/ack`.
 *
 * The backend is the only record, so any device can resume or undo:
 *
 * - BEFORE each write the client acks the fact undo will need — the profile
 *   values it is about to overwrite, which targets of a batch the user already
 *   follows or blocks. The backend keeps the FIRST value of each fact, so a run
 *   resumed after a crash cannot record Move's own writes as the user's.
 * - AFTER each write it acks what was applied (`profileApplied`, batch indexes).
 *
 * Every run starts from `GET /jobs/:id/plan` and skips what the ack records.
 */

import type {
  MigrationPlan,
  PlanAck,
  PlanAckRequest,
  PlanResponse,
  PlanUndoFacts,
  ProfilePlan,
  ProfileSnapshot,
} from '@move/shared-types';

/** The Oxy SDK methods the plan needs — all run with the user's own session. */
export interface PlanSdk {
  users: {
    me(): Promise<{ name?: { displayName?: string } | null; bio?: string; avatar?: string | null; links?: string[] }>;
    updateMe(update: ProfileUpdate): Promise<unknown>;
  };
  follows: {
    statuses(userIds: string[]): Promise<Record<string, boolean>>;
    followMany(userIds: string[]): Promise<unknown>;
    unfollowMany(userIds: string[]): Promise<unknown>;
  };
  privacy: {
    blocked(): Promise<Array<{ blockedId: string | { _id: string } }>>;
    block(userId: string): Promise<unknown>;
    unblock(userId: string): Promise<unknown>;
  };
}

/**
 * The subset of the SDK's `UserProfileUpdate` Move writes. A type alias, not an
 * interface: the SDK's type is a passthrough object (`{ [k: string]: unknown }`),
 * which only an alias is implicitly assignable to.
 */
export type ProfileUpdate = {
  name?: { displayName: string };
  bio?: string;
  avatar?: string;
  links?: string[];
};

/** The Move API calls the plan needs. */
export interface PlanApi {
  plan(jobId: string): Promise<PlanResponse>;
  ack(jobId: string, ack: PlanAckRequest): Promise<unknown>;
}

export interface PlanDeps {
  api: PlanApi;
  sdk: PlanSdk;
}

export interface PlanProgress {
  profile: 'none' | 'pending' | 'applied';
  batchesTotal: number;
  batchesApplied: number;
  /** Accounts in the applied follow batches. */
  followsApplied: number;
  blockBatchesTotal: number;
  blockBatchesApplied: number;
  /** Accounts in the applied block batches. */
  blocksApplied: number;
  /** Accounts in every block batch. */
  blocksTotal: number;
}

/** The Oxy SDK's bulk follow endpoints cap a batch at 200 (`FOLLOW_BATCH_SIZE`). */
const UNFOLLOW_CHUNK = 200;

/** The profile update a plan asks for; `null` when it changes nothing. */
function profileUpdateFor(plan: ProfilePlan): ProfileUpdate | null {
  const update: ProfileUpdate = {};
  if (plan.displayName) update.name = { displayName: plan.displayName };
  if (plan.bio) update.bio = plan.bio;
  if (plan.avatarFileId) update.avatar = plan.avatarFileId;
  if (plan.links && plan.links.length > 0) update.links = plan.links;
  return Object.keys(update).length > 0 ? update : null;
}

/** The current values of exactly the fields `update` is about to overwrite. */
function snapshotFor(
  update: ProfileUpdate,
  me: Awaited<ReturnType<PlanSdk['users']['me']>>,
): ProfileSnapshot {
  const before: ProfileSnapshot = {};
  if (update.name) before.displayName = me.name?.displayName ?? '';
  if (update.bio !== undefined) before.bio = me.bio ?? '';
  // An avatar cannot be cleared back to "none", so only a real one is restored.
  if (update.avatar !== undefined && me.avatar) before.avatar = me.avatar;
  if (update.links !== undefined) before.links = me.links ?? [];
  return before;
}

function restoreFrom(snapshot: ProfileSnapshot): ProfileUpdate {
  const update: ProfileUpdate = {};
  if (snapshot.displayName !== undefined) update.name = { displayName: snapshot.displayName };
  if (snapshot.bio !== undefined) update.bio = snapshot.bio;
  if (snapshot.avatar !== undefined) update.avatar = snapshot.avatar;
  if (snapshot.links !== undefined) update.links = snapshot.links;
  return update;
}

function planProgress(plan: MigrationPlan, ack: PlanAck | null): PlanProgress {
  const follows = plan.graph?.followBatches ?? [];
  const blocks = plan.blocks?.blockBatches ?? [];
  const followsDone = new Set(ack?.followBatchesApplied ?? []);
  const blocksDone = new Set(ack?.blockBatchesApplied ?? []);
  const count = (batches: string[][], done: Set<number>) =>
    batches.reduce((sum, batch, index) => sum + (done.has(index) ? batch.length : 0), 0);
  return {
    profile: !plan.profile || !profileUpdateFor(plan.profile) ? 'none' : ack?.profileApplied ? 'applied' : 'pending',
    batchesTotal: follows.length,
    batchesApplied: follows.filter((_, index) => followsDone.has(index)).length,
    followsApplied: count(follows, followsDone),
    blockBatchesTotal: blocks.length,
    blockBatchesApplied: blocks.filter((_, index) => blocksDone.has(index)).length,
    blocksApplied: count(blocks, blocksDone),
    blocksTotal: blocks.reduce((sum, batch) => sum + batch.length, 0),
  };
}

/** True when the plan holds something the ack does not record yet. */
export function planHasPendingWork(plan: MigrationPlan, ack: PlanAck | null): boolean {
  const progress = planProgress(plan, ack);
  return (
    progress.profile === 'pending' ||
    progress.batchesApplied < progress.batchesTotal ||
    progress.blockBatchesApplied < progress.blockBatchesTotal
  );
}

function blockedIdOf(entry: { blockedId: string | { _id: string } }): string {
  return typeof entry.blockedId === 'string' ? entry.blockedId : entry.blockedId._id;
}

/**
 * Apply whatever of the job's plan is not acknowledged yet. Safe to call
 * repeatedly, from any device, while the backend is still building the plan.
 */
export async function applyPlan(
  deps: PlanDeps,
  jobId: string,
  onProgress?: (progress: PlanProgress) => void,
): Promise<PlanProgress> {
  const { plan, ack: recorded, undoFacts } = await deps.api.plan(jobId);
  const facts: PlanUndoFacts = undoFacts ?? {};
  const ack: Required<PlanAck> = {
    profileApplied: recorded?.profileApplied ?? false,
    followBatchesApplied: [...(recorded?.followBatchesApplied ?? [])],
    blockBatchesApplied: [...(recorded?.blockBatchesApplied ?? [])],
  };
  const report = () => onProgress?.(planProgress(plan, ack));
  report();

  const update = plan.profile ? profileUpdateFor(plan.profile) : null;
  if (update && !ack.profileApplied) {
    if (!facts.profileBefore) {
      await deps.api.ack(jobId, { profileBefore: snapshotFor(update, await deps.sdk.users.me()) });
    }
    await deps.sdk.users.updateMe(update);
    await deps.api.ack(jobId, { profileApplied: true });
    ack.profileApplied = true;
    report();
  }

  const follows = plan.graph?.followBatches ?? [];
  for (let index = 0; index < follows.length; index += 1) {
    if (ack.followBatchesApplied.includes(index)) continue;
    const batch = follows[index];
    if (!facts.alreadyFollowing?.[index]) {
      const statuses = batch.length > 0 ? await deps.sdk.follows.statuses(batch) : {};
      const already = batch.filter((userId) => statuses[userId] === true);
      await deps.api.ack(jobId, { alreadyFollowing: { [index]: already } });
    }
    if (batch.length > 0) await deps.sdk.follows.followMany(batch);
    await deps.api.ack(jobId, { followBatchesApplied: [index] });
    ack.followBatchesApplied.push(index);
    report();
  }

  const blocks = plan.blocks?.blockBatches ?? [];
  let blockedNow: Set<string> | null = null;
  for (let index = 0; index < blocks.length; index += 1) {
    if (ack.blockBatchesApplied.includes(index)) continue;
    const batch = blocks[index];
    // Read once per run, before this run blocks anyone.
    blockedNow ??= new Set((await deps.sdk.privacy.blocked()).map(blockedIdOf));
    const current = blockedNow;
    const recordedAlready = facts.alreadyBlocked?.[index];
    if (!recordedAlready) {
      await deps.api.ack(jobId, { alreadyBlocked: { [index]: batch.filter((userId) => current.has(userId)) } });
    }
    // The SDK blocks one account per call; skip who is blocked already.
    for (const userId of batch) {
      if (!current.has(userId)) await deps.sdk.privacy.block(userId);
    }
    await deps.api.ack(jobId, { blockBatchesApplied: [index] });
    ack.blockBatchesApplied.push(index);
    report();
  }

  return planProgress(plan, ack);
}

interface UndoPlanResult {
  unfollowed: number;
  unblocked: number;
  /** Follows/blocks kept because the user had them before Move, or no fact says otherwise. */
  kept: number;
  profileRestored: boolean;
  /** Move changed the profile but no snapshot was recorded (a plan acked before facts existed). */
  profileKept: boolean;
}

/**
 * Reverse what the ack says the client applied, using the facts the backend
 * recorded: unfollow/unblock only accounts Move added, and restore the profile.
 * Works on any device — nothing is read from local storage.
 */
export async function undoPlan(
  deps: Pick<PlanDeps, 'sdk'>,
  { plan, ack, undoFacts }: PlanResponse,
): Promise<UndoPlanResult> {
  const result: UndoPlanResult = { unfollowed: 0, unblocked: 0, kept: 0, profileRestored: false, profileKept: false };

  const created = (batches: string[][], applied: number[] | undefined, already: Record<string, string[]> | undefined) => {
    const out: string[] = [];
    for (const index of applied ?? []) {
      const batch = batches[index] ?? [];
      const fact = already?.[index];
      if (!fact) {
        // No record of what the user had before: leave the whole batch alone.
        result.kept += batch.length;
        continue;
      }
      const had = new Set(fact);
      for (const userId of batch) {
        if (had.has(userId)) result.kept += 1;
        else out.push(userId);
      }
    }
    return out;
  };

  const toUnfollow = created(plan.graph?.followBatches ?? [], ack?.followBatchesApplied, undoFacts?.alreadyFollowing);
  for (let start = 0; start < toUnfollow.length; start += UNFOLLOW_CHUNK) {
    await deps.sdk.follows.unfollowMany(toUnfollow.slice(start, start + UNFOLLOW_CHUNK));
  }
  result.unfollowed = toUnfollow.length;

  const toUnblock = created(plan.blocks?.blockBatches ?? [], ack?.blockBatchesApplied, undoFacts?.alreadyBlocked);
  for (const userId of toUnblock) await deps.sdk.privacy.unblock(userId);
  result.unblocked = toUnblock.length;

  if (ack?.profileApplied && plan.profile && profileUpdateFor(plan.profile)) {
    if (undoFacts?.profileBefore) {
      const restore = restoreFrom(undoFacts.profileBefore);
      if (Object.keys(restore).length > 0) await deps.sdk.users.updateMe(restore);
      result.profileRestored = true;
    } else {
      result.profileKept = true;
    }
  }
  return result;
}
