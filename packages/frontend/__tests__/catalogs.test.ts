/**
 * The two catalogs must say the same things: a key missing from one silently
 * falls back to English (or renders the key itself), which no typecheck sees.
 */

import { expect, test } from 'bun:test';
import { JOB_STATUSES, PHASE_STATUSES, UPCOMING_PLATFORMS, MIGRATION_PLATFORMS } from '@move/shared-types';
import en from '../locales/en.json';
import es from '../locales/es.json';
import { LINKED_ACCOUNT_CALLBACK_ERRORS, LINKED_ACCOUNT_START_ERROR_REASONS } from '@oxy.so/contracts';
import { startFailureKey } from '../lib/handles';

type Catalog = { [key: string]: string | Catalog };

function keys(catalog: Catalog, prefix = ''): string[] {
  return Object.entries(catalog).flatMap(([key, value]) =>
    typeof value === 'string' ? [prefix + key] : keys(value, `${prefix}${key}.`),
  );
}

test('en and es carry exactly the same keys', () => {
  const english = keys(en as Catalog).sort();
  expect(english.length).toBeGreaterThan(100);
  expect(keys(es as Catalog).sort()).toEqual(english);
});

test('every code and status the app renders has a message', () => {
  const english = new Set(keys(en as Catalog));
  const required = [
    ...LINKED_ACCOUNT_CALLBACK_ERRORS.map((code) => `linkErrors.${code}`),
    'linkErrors.already_linked',
    'linkErrors.expired_or_foreign',
    'linkErrors.unknown',
    ...JOB_STATUSES.map((status) => `status.${status}`),
    ...PHASE_STATUSES.map((status) => `phaseStatus.${status}`),
    ...[...MIGRATION_PLATFORMS, ...UPCOMING_PLATFORMS].map((id) => `platformNames.${id}`),
    ...MIGRATION_PLATFORMS.flatMap((platform) => [
      ...LINKED_ACCOUNT_START_ERROR_REASONS.map((reason) => startFailureKey(platform, { details: { reason } })),
      startFailureKey(platform, new Error('network')),
    ]),
  ];
  expect(required.filter((key) => !english.has(key))).toEqual([]);
});
