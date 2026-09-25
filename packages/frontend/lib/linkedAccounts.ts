/**
 * TEMPORARY adapter for Oxy's linked-accounts SDK methods, which are not in a
 * published `@oxy.so/core` yet (oxy `packages/core/src/mixins/OxyServices.linkedAccounts.ts`).
 * It has the SDK's exact method signatures, and the types mirror
 * `@oxy.so/contracts` `linkedAccounts.ts`.
 *
 * When core ships them, delete this file: `linkedAccounts(oxyServices).x(…)`
 * becomes `oxyServices.x(…)`, and the types import from `@oxy.so/contracts`.
 */

import type { OxyServices } from '@oxy.so/core';

export type LinkedAccountNetwork = 'activitypub' | 'atproto';

export interface StartLinkedAccountRequest {
  /** ActivityPub: `mastodon.social`, `https://mastodon.social` or `@user@mastodon.social`. */
  instance?: string;
  /** atproto: a handle (`alice.bsky.social`) or a DID. */
  handle?: string;
  clientId?: string;
  /** Must exactly match a redirect URI registered on `clientId`'s application. */
  returnTo?: string;
}

export interface StartLinkedAccountResponse {
  authorizeUrl: string;
  expiresAt: string;
}

export interface LinkedAccount {
  id: string;
  network: LinkedAccountNetwork;
  accountKey: string;
  actorUri: string;
  handle: string;
  host: string;
  proofMethod: 'oauth';
  verifiedAt: string;
  createdAt: string;
}

/**
 * The codes Oxy's callback appends to `returnTo` as `?link_error=<code>`. An
 * account already linked to someone else is reported by `/complete` (409).
 */
export const LINKED_ACCOUNT_CALLBACK_ERRORS = [
  'access_denied',
  'verification_failed',
  'provider_unavailable',
] as const;
export type LinkedAccountCallbackError = (typeof LINKED_ACCOUNT_CALLBACK_ERRORS)[number];

export interface LinkedAccountsApi {
  startLinkedAccount(network: LinkedAccountNetwork, options: StartLinkedAccountRequest): Promise<StartLinkedAccountResponse>;
  /**
   * Finish a link with the callback's `link_code`, as the user who started it:
   * 403 for anyone else (the code is burned), 404 unknown/expired, 409 when the
   * account is already someone else's link.
   */
  completeLinkedAccount(code: string): Promise<LinkedAccount>;
  listLinkedAccounts(): Promise<LinkedAccount[]>;
  revokeLinkedAccount(linkedAccountId: string): Promise<void>;
}

export function linkedAccounts(oxy: Pick<OxyServices, 'makeRequest'>): LinkedAccountsApi {
  return {
    startLinkedAccount: (network, options) =>
      oxy.makeRequest<StartLinkedAccountResponse>('POST', `/linked-accounts/${encodeURIComponent(network)}/start`, options, {
        cache: false,
      }),
    completeLinkedAccount: async (code) =>
      (
        await oxy.makeRequest<{ linkedAccount: LinkedAccount }>('POST', '/linked-accounts/complete', { code }, {
          cache: false,
        })
      ).linkedAccount,
    listLinkedAccounts: async () =>
      (await oxy.makeRequest<{ linkedAccounts: LinkedAccount[] }>('GET', '/linked-accounts', undefined, { cache: false })).linkedAccounts,
    revokeLinkedAccount: async (linkedAccountId) => {
      await oxy.makeRequest<void>('DELETE', `/linked-accounts/${encodeURIComponent(linkedAccountId)}`, undefined, { cache: false });
    },
  };
}
