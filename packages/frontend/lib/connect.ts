/**
 * Proving ownership of an external account: Oxy's linked-account OAuth, opened
 * with `expo-web-browser`'s auth session (a popup on web, an in-app browser
 * session on native) and returned to `LINKED_RETURN_TO` with `?linked=<id>` or
 * `?link_error=<code>`.
 */

import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import type { OxyServices } from '@oxy.so/core';
import type { MigrationPlatform } from '@move/shared-types';
import { LINKED_RETURN_TO, MENTION_FEDERATION_DOMAIN, OXY_CLIENT_ID } from './config';
import { PLATFORM_NETWORK, formatMentionHandle, outcomeFromParams, type LinkOutcome } from './handles';
import { linkedAccounts } from './linkedAccounts';

let pendingAuthSession = false;

/**
 * True while an auth session is open. On Android the `oxymove://linked` return
 * also reaches expo-router as a deep link; `app/+native-intent.tsx` drops it
 * then, because the session's own result already carries the outcome.
 */
export function isAuthSessionPending(): boolean {
  return pendingAuthSession;
}

function outcomeFromUrl(url: string): LinkOutcome {
  const { queryParams } = Linking.parse(url);
  return outcomeFromParams(queryParams ?? {}) ?? { kind: 'error', code: 'unknown' };
}

/**
 * Start the link and wait for the browser to come back. Throws only when Oxy
 * refuses to START (bad instance, unresolvable handle); the callback's own
 * failures come back as `{ kind: 'error' }`.
 */
export async function linkAccount(
  oxy: Pick<OxyServices, 'makeRequest'>,
  platform: MigrationPlatform,
  input: string,
): Promise<LinkOutcome> {
  const network = PLATFORM_NETWORK[platform];
  const { authorizeUrl } = await linkedAccounts(oxy).startLinkedAccount(network, {
    ...(network === 'activitypub' ? { instance: input } : { handle: input }),
    clientId: OXY_CLIENT_ID,
    returnTo: LINKED_RETURN_TO,
  });
  pendingAuthSession = true;
  try {
    const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, LINKED_RETURN_TO);
    if (result.type === 'success') return outcomeFromUrl(result.url);
    return { kind: 'cancelled' };
  } finally {
    pendingAuthSession = false;
  }
}

/** The signed-in user's handle on Mention, the target of a Mastodon account move. */
export function mentionHandle(username: string): string {
  return formatMentionHandle(username, MENTION_FEDERATION_DOMAIN);
}
