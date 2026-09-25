/**
 * Proving ownership of an external account: Oxy's linked-account OAuth, opened
 * with `expo-web-browser`'s auth session (a popup on web, an in-app browser
 * session on native) and returned to `LINKED_RETURN_TO` with `?link_code=<code>`
 * or `?link_error=<code>`. The code becomes the link only when the signed-in
 * user completes it (`completeLink`).
 */

import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import type { OxyServices } from '@oxy.so/core';
import type { MigrationPlatform } from '@move/shared-types';
import { LINKED_RETURN_TO, MENTION_FEDERATION_DOMAIN, OXY_CLIENT_ID } from './config';
import { PLATFORM_NETWORK, completeLink, formatMentionHandle, outcomeFromParams, type LinkOutcome, type LinkResult } from './handles';

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

/** How a connect attempt ended: linked, refused, or closed by the user. */
export type LinkAttempt = LinkResult | { kind: 'cancelled' };

/**
 * Start the link, wait for the browser to come back, and complete it. Throws
 * only when Oxy refuses to START (bad instance, unresolvable handle); every
 * later failure comes back as `{ kind: 'error' }`.
 */
export async function linkAccount(
  oxy: Pick<OxyServices, 'startLinkedAccount' | 'completeLinkedAccount'>,
  platform: MigrationPlatform,
  input: string,
): Promise<LinkAttempt> {
  const network = PLATFORM_NETWORK[platform];
  const { authorizeUrl } = await oxy.startLinkedAccount(network, {
    ...(network === 'activitypub' ? { instance: input } : { handle: input }),
    clientId: OXY_CLIENT_ID,
    returnTo: LINKED_RETURN_TO,
  });
  let outcome: LinkOutcome | { kind: 'cancelled' };
  pendingAuthSession = true;
  try {
    const result = await WebBrowser.openAuthSessionAsync(authorizeUrl, LINKED_RETURN_TO);
    outcome = result.type === 'success' ? outcomeFromUrl(result.url) : { kind: 'cancelled' };
  } finally {
    pendingAuthSession = false;
  }
  return outcome.kind === 'code' ? completeLink(oxy, outcome.code) : outcome;
}

/** The signed-in user's handle on Mention, the target of a Mastodon account move. */
export function mentionHandle(username: string): string {
  return formatMentionHandle(username, MENTION_FEDERATION_DOMAIN);
}
