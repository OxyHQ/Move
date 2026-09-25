/**
 * Pure helpers for the connect flow and the Mastodon move step — no React
 * Native imports, so the unit tests load them directly.
 */

import type { MigrationPlatform } from '@move/shared-types';
import { LINKED_ACCOUNT_CALLBACK_ERRORS, type LinkedAccountCallbackError, type LinkedAccountNetwork } from './linkedAccounts';

/** The Oxy network a Move source platform proves ownership through. */
export const PLATFORM_NETWORK: Record<MigrationPlatform, LinkedAccountNetwork> = {
  mastodon: 'activitypub',
  bluesky: 'atproto',
};

export function platformForNetwork(network: LinkedAccountNetwork): MigrationPlatform {
  return network === 'activitypub' ? 'mastodon' : 'bluesky';
}

function isLinkedAccountCallbackError(value: string): value is LinkedAccountCallbackError {
  return (LINKED_ACCOUNT_CALLBACK_ERRORS as readonly string[]).includes(value);
}

export type LinkOutcome =
  | { kind: 'linked'; linkedAccountId: string }
  | { kind: 'error'; code: LinkedAccountCallbackError | 'unknown' }
  | { kind: 'cancelled' };

/**
 * Read `?linked=` / `?link_error=` off a return URL's query or a route's params.
 * Oxy reports a failed link as `link_error`, not `error`, because
 * `@oxy.so/services` strips any `?error=` (an OAuth error) on web cold boot.
 */
export function outcomeFromParams(params: { linked?: unknown; link_error?: unknown }): LinkOutcome | null {
  if (typeof params.linked === 'string' && params.linked.length > 0) {
    return { kind: 'linked', linkedAccountId: params.linked };
  }
  const code = params.link_error;
  if (typeof code === 'string' && code.length > 0) {
    return { kind: 'error', code: isLinkedAccountCallbackError(code) ? code : 'unknown' };
  }
  return null;
}

/** The i18n key for a callback error code. */
export function linkErrorKey(code: LinkedAccountCallbackError | 'unknown'): string {
  return `linkErrors.${code}`;
}

/** What the user typed, as the `start` request expects it; `null` when it cannot be one. */
export function normalizeSourceInput(platform: MigrationPlatform, raw: string): string | null {
  const value = raw.trim();
  if (platform === 'bluesky') {
    const handle = value.replace(/^@/, '');
    return handle.startsWith('did:') || /^[^\s@/]+\.[^\s@/]+$/.test(handle) ? handle : null;
  }
  // Mastodon: `@user@instance`, `user@instance`, `instance` or `https://instance`
  // — Oxy accepts every one of them as `instance`.
  const host = value
    .replace(/^https?:\/\//i, '')
    .replace(/^@?[^@\s/]+@/, '')
    .replace(/\/.*$/, '');
  return /^[^\s@/]+\.[^\s@/]+$/.test(host) ? value : null;
}

/** A Mention user's fediverse handle: `@<username>@<federation domain>`. */
export function formatMentionHandle(username: string, federationDomain: string): string {
  return `@${username}@${federationDomain}`;
}

/** Mastodon's "Move to a different account" page on the source actor's instance. */
export function mastodonMigrationUrl(sourceActor: string): string | null {
  const match = /^https?:\/\/([^/?#]+)/i.exec(sourceActor.trim());
  return match ? `https://${match[1]}/settings/migration` : null;
}
