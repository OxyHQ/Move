/**
 * Production composition of the pipeline's dependencies — the one place the
 * real Oxy client, Mention client, media limiter and source factory are wired.
 * Tests build their own {@link PipelineDeps} with fakes instead.
 */

import { config } from '../config';
import { getDb } from '../db/postgres';
import { createMediaCopier, createUploadLimiter } from '../destinations/media';
import { MentionDestination } from '../destinations/mention';
import { OxyGateway } from '../destinations/oxy';
import { enqueueMigrationRun } from '../queue/queues';
import { createSourceFactory } from '../sources';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { logger } from '../utils/logger';
import { runMigrationJob, type PipelineDeps } from '../pipeline/runner';
import { JobService } from '../pipeline/jobService';
import { socketProgressSink } from './socketServer';

export function createPipelineDeps(): PipelineDeps {
  const oxyClient = getServiceOxyClient();
  return {
    db: getDb(),
    oxy: new OxyGateway(oxyClient),
    destination: new MentionDestination({ baseUrl: config.mentionApiUrl, oxy: oxyClient }),
    media: createMediaCopier({ limiter: createUploadLimiter(config.media.uploadsPerMinute) }),
    sourceFactory: createSourceFactory(),
    progress: socketProgressSink,
  };
}

/**
 * Without Redis (local development only) there is no queue: a job runs
 * in-process and a pause or a transient failure is a timer.
 */
function runInline(deps: PipelineDeps, jobId: string, delayMs = 0): void {
  setTimeout(() => {
    void runMigrationJob(jobId, deps)
      .then((outcome) => {
        if (outcome.status === 'paused') runInline(deps, jobId, outcome.resumeAt.getTime() - Date.now());
        if (outcome.status === 'retry') runInline(deps, jobId, 30_000);
      })
      .catch((error) => logger.error('[pipeline] inline run failed', error));
  }, Math.max(0, delayMs)).unref();
}

export function createJobService(deps: PipelineDeps): JobService {
  return new JobService({
    ...deps,
    enqueue: async (jobId) => {
      if (!(await enqueueMigrationRun(jobId))) runInline(deps, jobId);
    },
  });
}
