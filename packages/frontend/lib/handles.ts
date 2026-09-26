/**
 * Pure helpers for the connect flow and the Mastodon move step — no React
 * Native imports, so the unit tests load them directly.
 */

import {
  LINKED_ACCOUNT_CALLBACK_ERRORS,
  linkedAccountStartErrorDetailsSchema,
  type LinkedAccountCallbackError,
  type LinkedAccountNetwork,
} from '@oxy.so/contracts';
import type { OxyServices } from '@oxy.so/core';
import type { MigrationPlatform } from '@move/shared-types';

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

/**
 * Why a link did not happen: a callback code, or what `/complete` refused —
 * `already_linked` (409: someone else's link) or `expired_or_foreign`
 * (403/404: the code expired, was used, or another user started the flow).
 */
export type LinkError = LinkedAccountCallbackError | 'already_linked' | 'expired_or_foreign' | 'unknown';

/** What the callback sent back: a one-time code to complete, or a failure. */
export type LinkOutcome = { kind: 'code'; code: string } | { kind: 'error'; code: LinkError };

/** The end of the flow: the link exists, or why not. */
export type LinkResult = { kind: 'linked'; linkedAccountId: string } | { kind: 'error'; code: LinkError };

/**
 * Read `?link_code=` / `?link_error=` off a return URL's query or a route's
 * params. Oxy reports a failed link as `link_error`, not `error`, because
 * `@oxy.so/services` strips any `?error=` (an OAuth error) on web cold boot.
 */
export function outcomeFromParams(params: { link_code?: unknown; link_error?: unknown }): LinkOutcome | null {
  if (typeof params.link_code === 'string' && params.link_code.length > 0) {
    return { kind: 'code', code: params.link_code };
  }
  const code = params.link_error;
  if (typeof code === 'string' && code.length > 0) {
    return { kind: 'error', code: isLinkedAccountCallbackError(code) ? code : 'unknown' };
  }
  return null;
}

function httpStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Turn the callback's one-time code into the link, as the signed-in user —
 * the ONLY place that does. Never throws: a refusal comes back as an error.
 */
/** The part of the SDK that completes a link. */
export type LinkCompleter = { linkedAccounts: Pick<OxyServices['linkedAccounts'], 'complete'> };

export async function completeLink(oxy: LinkCompleter, code: string): Promise<LinkResult> {
  try {
    const account = await oxy.linkedAccounts.complete(code);
    return { kind: 'linked', linkedAccountId: account.id };
  } catch (error) {
    const status = httpStatus(error);
    if (status === 409) return { kind: 'error', code: 'already_linked' };
    if (status === 403 || status === 404) return { kind: 'error', code: 'expired_or_foreign' };
    return { kind: 'error', code: 'unknown' };
  }
}

/**
 * The i18n key for why Oxy refused to START a link, from the refusal's
 * `details.reason` (`LINKED_ACCOUNT_START_ERROR_REASONS`). Only
 * `handle_unresolvable` and the two `instance_*` reasons point at what the user
 * typed; `provider_rejected` means the other network refused Oxy, and saying
 * "we couldn't find that account" then sends the user to fix a handle that is
 * fine. Anything without a reason (a network error, a client bug) is `unknown`.
 * Interpolate `{ name }`, the platform's display name.
 */
export function startFailureKey(platform: MigrationPlatform, error: unknown): string {
  const parsed = linkedAccountStartErrorDetailsSchema.safeParse((error as { details?: unknown } | null)?.details);
  if (!parsed.success) return 'connect.startFailed.unknown';
  const { reason } = parsed.data;
  return reason === 'provider_rejected' ? `connect.startFailed.provider_rejected.${platform}` : `connect.startFailed.${reason}`;
}

/** The i18n key for a link error code. */
export function linkErrorKey(code: LinkError): string {
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
