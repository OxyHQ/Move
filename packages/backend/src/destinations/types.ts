/**
 * The destination contract: where CONTENT goes.
 *
 * Mention is the only content destination in F1. The interface is what lets
 * Noted (articles) or Syra (audio) be added later without touching a source or
 * the pipeline's paging, deferral and checkpoint logic. Identity, profile and
 * graph are not a destination: Oxy owns them and the CLIENT applies them with the
 * user's own session (`destinations/oxy.ts` only prepares that plan).
 */

import type { MigrationPlatform } from '@move/shared-types';
import type { SourceItem } from '../sources/types';

/** A source item plus the Oxy asset ids its media were copied to. */
export interface PreparedItem extends SourceItem {
  media: Array<SourceItem['media'][number] & { assetId: string }>;
}

export interface DeliveryResult {
  sourceId: string;
  /**
   * `deferred`: the destination wrote NOTHING because the item's reply/quote
   * target is not there yet (`error` says which). Resend after the target lands,
   * or without the reference.
   */
  status: 'created' | 'existing' | 'deferred' | 'failed';
  destinationId?: string;
  error?: string;
}

export interface UndoResult {
  deleted: number;
  /** Posts the destination could not delete; a later undo retries them. */
  failed: number;
}

export interface ContentDestination {
  readonly name: 'mention';
  /** Largest batch one `deliver` call accepts. */
  readonly maxBatchSize: number;
  /** Idempotent: re-sending an item returns `existing` with the same id. */
  deliver(params: {
    oxyUserId: string;
    platform: MigrationPlatform;
    batchId: string;
    items: PreparedItem[];
  }): Promise<DeliveryResult[]>;
  /** Remove everything a batch created, through the destination's normal delete. */
  undo(params: { oxyUserId: string; batchId: string }): Promise<UndoResult>;
  /** Which of these source ids the destination already holds for the user (any batch). */
  lookupImported(params: {
    oxyUserId: string;
    platform: MigrationPlatform;
    sourceIds: string[];
  }): Promise<Set<string>>;
}

/** The destination refused because it is rate limiting us — pause, never fail. */
export class DestinationRateLimitedError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'DestinationRateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** A non-retryable refusal of the whole call (auth, contract mismatch). */
export class DestinationRejectedError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'DestinationRejectedError';
    this.status = status;
  }
}
