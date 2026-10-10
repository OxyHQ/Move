/** Runtime configuration, read from `EXPO_PUBLIC_*` env vars (see `.env.example`). */

import { Platform } from 'react-native';

/** Backend API base URL. */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'https://api.move.oxy.so';

/** The app's registered Oxy client id (ApplicationCredential publicKey). */
export const OXY_CLIENT_ID = process.env.EXPO_PUBLIC_OXY_CLIENT_ID ?? '';

/**
 * Oxy's API — what `OxyProvider` talks to for sessions and accounts. NOT the app
 * backend: the scaffold passed `API_URL` here, which points the Oxy SDK at
 * api.move.oxy.so (Mention passes `https://api.oxy.so`, `config.ts:47`).
 */
export const OXY_API_URL = process.env.EXPO_PUBLIC_OXY_API_URL ?? 'https://api.oxy.so';

/** Move's public web origin. */
const MOVE_WEB_URL = process.env.EXPO_PUBLIC_WEB_URL ?? 'https://move.oxy.so';

/** The native scheme (`app.config.js` `scheme`). */
const NATIVE_SCHEME = 'oxymove';

/**
 * Where Oxy's linked-account callback sends the browser back to. It must be one
 * of the redirect URIs registered on Move's Oxy application, EXACTLY: Oxy
 * refuses any other `returnTo`.
 */
export const LINKED_RETURN_TO =
  Platform.OS === 'web' ? `${MOVE_WEB_URL}/linked` : `${NATIVE_SCHEME}://linked`;

/** Mention's web origin — where imported posts are read. */
export const MENTION_WEB_URL = process.env.EXPO_PUBLIC_MENTION_WEB_URL ?? 'https://mention.earth';

/**
 * Mention's ActivityPub domain: a local user is `@<username>@mention.earth`
 * (Mention `connectors/activitypub/constants.ts` `FEDERATION_DOMAIN`).
 */
export const MENTION_FEDERATION_DOMAIN =
  process.env.EXPO_PUBLIC_MENTION_FEDERATION_DOMAIN ?? 'mention.earth';
