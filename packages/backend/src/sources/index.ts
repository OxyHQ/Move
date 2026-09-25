/**
 * Source registry: the one place a platform name becomes a reader. Adding a
 * platform is a module implementing {@link Source}, one case here, the tuple in
 * `@move/shared-types`, and a CHECK-widening migration.
 */

import { resolvePdsEndpoint } from '../connectors/atproto/xrpcClient';
import { logger } from '../utils/logger';
import { BlueskySource } from './bluesky';
import { PLATFORM_BACKOFF, fetchPublicJson, withBackoff } from './http';
import { MastodonSource } from './mastodon';
import type { Source, SourceAccount } from './types';

export type SourceFactory = (account: SourceAccount) => Promise<Source>;

export function createSourceFactory(): SourceFactory {
  return async (account) => {
    switch (account.platform) {
      case 'mastodon':
        return new MastodonSource(account, withBackoff(fetchPublicJson, PLATFORM_BACKOFF.mastodon));
      case 'bluesky': {
        let pdsEndpoint: string | undefined;
        try {
          pdsEndpoint = await resolvePdsEndpoint(account.actor);
        } catch (error) {
          logger.warn('[sources] Bluesky DID document unavailable; images fall back to the CDN and blocks are skipped', error);
        }
        return new BlueskySource(account, withBackoff(fetchPublicJson, PLATFORM_BACKOFF.bluesky), { pdsEndpoint });
      }
      default: {
        const exhaustive: never = account.platform;
        throw new Error(`Unsupported platform ${String(exhaustive)}`);
      }
    }
  };
}
