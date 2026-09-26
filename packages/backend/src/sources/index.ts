/**
 * Source registry: the one place a platform name becomes a reader. Adding a
 * platform is a module implementing {@link Source}, one case here, the tuple in
 * `@move/shared-types`, and a CHECK-widening migration.
 */

import { resolvePdsEndpoint } from '../connectors/atproto/xrpcClient';
import { logger } from '../utils/logger';
import { BlueskySource } from './bluesky';
import { PLATFORM_BACKOFF, createPublicJsonFetcher, fetchPublicJson, withBackoff, type RequestSigner } from './http';
import { MastodonSource } from './mastodon';
import type { Source, SourceAccount } from './types';

export type SourceFactory = (account: SourceAccount) => Promise<Source>;

/**
 * @param signer signs an ActivityPub GET a server refused unsigned (Oxy's
 *   instance actor, `createInstanceFetchSigner`). Without one, such a server
 *   fails the job with `source-requires-authorized-fetch`.
 */
export function createSourceFactory(signer?: RequestSigner): SourceFactory {
  const mastodonFetcher = createPublicJsonFetcher(signer);
  return async (account) => {
    switch (account.platform) {
      case 'mastodon':
        return new MastodonSource(account, withBackoff(mastodonFetcher, PLATFORM_BACKOFF.mastodon));
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
