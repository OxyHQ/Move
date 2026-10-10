import { isAuthSessionPending } from '@/lib/connect';

/**
 * While a linked-account auth session is open, its `oxymove://linked?...`
 * return is the SESSION's result (`openAuthSessionAsync` resolves with it). On
 * Android the same URL also reaches expo-router as a deep link; navigating to
 * `/linked` too would show the outcome twice, so it is dropped here. A cold
 * start (`initial`) or a return with no session open still routes normally.
 */
export function redirectSystemPath({
  path,
  initial,
}: {
  path: string;
  initial: boolean;
}): string | null {
  try {
    if (!initial && isAuthSessionPending() && /(^|\/\/|\/)linked(\?|$)/.test(path)) return null;
  } catch {
    // Never crash the router on a malformed path.
  }
  return path;
}
