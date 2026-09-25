/**
 * Move's API. Every route is behind the Oxy session (`createOxyAuthMiddleware`);
 * the user id comes from the verified session, never the body.
 *
 *   GET    /platforms
 *   POST   /jobs              { platform, linkedAccountId, options?, dryRun? }
 *   GET    /jobs
 *   GET    /jobs/:id
 *   GET    /jobs/:id/plan
 *   POST   /jobs/:id/plan/ack { profileApplied?, followBatchesApplied?, blockBatchesApplied?,
 *                              profileBefore?, alreadyFollowing?, alreadyBlocked? }
 *   POST   /jobs/:id/cancel
 *   DELETE /jobs/:id          (undo)
 */

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { getRequiredOxyUserId, type OxyAuthenticatedRequest } from '@oxy.so/core/server';
import { FOLLOW_BATCH_SIZE, MIGRATION_PLATFORMS, type PlatformInfo } from '@move/shared-types';
import { ForeignLinkedAccountError } from '../destinations/oxy';
import { SourceAuthRequiredError, SourceUnavailableError } from '../sources/http';
import {
  JobConflictError,
  JobNotFoundError,
  JobStateError,
  toJobView,
  type JobService,
} from '../pipeline/jobService';
import { logger } from '../utils/logger';

const PLATFORMS: PlatformInfo[] = [
  { id: 'mastodon', status: 'available', brings: ['profile', 'graph', 'posts'] },
  { id: 'bluesky', status: 'available', brings: ['profile', 'graph', 'posts'] },
  { id: 'threads', status: 'soon', brings: ['profile', 'graph', 'posts'] },
  { id: 'instagram', status: 'soon', brings: ['profile', 'posts'] },
  { id: 'x', status: 'soon', brings: ['profile', 'graph', 'posts'] },
  { id: 'medium', status: 'soon', brings: ['profile', 'articles'] },
  { id: 'substack', status: 'soon', brings: ['profile', 'articles'] },
];

const createJobSchema = z.object({
  platform: z.enum(MIGRATION_PLATFORMS),
  linkedAccountId: z.string().trim().min(1).max(200),
  options: z
    .object({
      content: z.boolean(),
      graph: z.boolean(),
      profile: z.boolean(),
      includeBoosts: z.boolean(),
      includeRepliesToOthers: z.boolean(),
    })
    .partial()
    .strict()
    .optional(),
  dryRun: z.boolean().optional(),
});

const batchIndexes = z.array(z.number().int().min(0)).max(10_000).optional();
/** Batch index → Oxy user ids; a batch holds at most FOLLOW_BATCH_SIZE (200). */
const batchFacts = z
  .record(z.string().regex(/^\d+$/), z.array(z.string().min(1).max(200)).max(FOLLOW_BATCH_SIZE))
  .refine((value) => Object.keys(value).length <= 1_000, 'too many batches')
  .optional();

const ackSchema = z
  .object({
    profileApplied: z.boolean().optional(),
    followBatchesApplied: batchIndexes,
    blockBatchesApplied: batchIndexes,
    profileBefore: z
      .object({
        displayName: z.string().max(500).optional(),
        bio: z.string().max(10_000).optional(),
        avatar: z.string().min(1).max(200).optional(),
        links: z.array(z.string().max(2048)).max(50).optional(),
      })
      .strict()
      .optional(),
    alreadyFollowing: batchFacts,
    alreadyBlocked: batchFacts,
  })
  .strict();

const jobIdSchema = z.string().trim().min(1).max(64);

type Handler = (req: Request, res: Response) => Promise<void>;

/** Map a service error to its HTTP answer; anything unknown is a 500 via `next`. */
function handle(fn: Handler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((error: unknown) => {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: 'invalid_request', issues: error.issues.map((issue) => issue.message) });
      } else if (error instanceof ForeignLinkedAccountError) {
        res.status(403).json({ error: 'linked_account_not_owned', message: error.message });
      } else if (error instanceof JobNotFoundError) {
        res.status(404).json({ error: 'not_found' });
      } else if (error instanceof JobConflictError) {
        res.status(409).json({ error: 'active_job_exists', message: error.message });
      } else if (error instanceof JobStateError) {
        res.status(409).json({ error: 'invalid_state', message: error.message });
      } else if (error instanceof SourceAuthRequiredError) {
        res.status(422).json({ error: 'source_requires_authorized_fetch' });
      } else if (error instanceof SourceUnavailableError) {
        res.status(422).json({ error: 'source_unavailable' });
      } else {
        logger.error('[api] unhandled error', error);
        next(error);
      }
    });
  };
}

function userId(req: Request): string {
  return getRequiredOxyUserId(req as OxyAuthenticatedRequest);
}

export function createJobsRouter(jobs: JobService, auth: RequestHandler): Router {
  const router = Router();

  // Public: what the home screen shows before sign-in.
  router.get('/platforms', (_req, res) => {
    res.json({ platforms: PLATFORMS });
  });

  router.use('/jobs', auth);

  router.post('/jobs', handle(async (req, res) => {
    const body = createJobSchema.parse(req.body);
    if (body.dryRun) {
      const preview = await jobs.preview(userId(req), body.platform, body.linkedAccountId);
      res.json({ preview });
      return;
    }
    const job = await jobs.create(userId(req), body);
    res.status(201).json({ job: toJobView(job) });
  }));

  router.get('/jobs', handle(async (req, res) => {
    const rows = await jobs.list(userId(req));
    res.json({ jobs: rows.map(toJobView) });
  }));

  router.get('/jobs/:id', handle(async (req, res) => {
    const job = await jobs.get(userId(req), jobIdSchema.parse(req.params.id));
    res.json({ job: toJobView(job) });
  }));

  router.get('/jobs/:id/plan', handle(async (req, res) => {
    const result = await jobs.plan(userId(req), jobIdSchema.parse(req.params.id));
    res.json(result);
  }));

  router.post('/jobs/:id/plan/ack', handle(async (req, res) => {
    const job = await jobs.ackPlan(userId(req), jobIdSchema.parse(req.params.id), ackSchema.parse(req.body ?? {}));
    res.json({ job: toJobView(job) });
  }));

  router.post('/jobs/:id/cancel', handle(async (req, res) => {
    const job = await jobs.cancel(userId(req), jobIdSchema.parse(req.params.id));
    res.json({ job: toJobView(job) });
  }));

  router.delete('/jobs/:id', handle(async (req, res) => {
    const result = await jobs.undo(userId(req), jobIdSchema.parse(req.params.id));
    // The client reverses what only its session can (profile, follows, blocks),
    // from the facts recorded before it applied them — on any device.
    res.json({
      job: toJobView(result.job),
      deleted: result.deleted,
      failed: result.failed,
      plan: result.plan,
      ack: result.ack,
      undoFacts: result.undoFacts,
    });
  }));

  return router;
}
