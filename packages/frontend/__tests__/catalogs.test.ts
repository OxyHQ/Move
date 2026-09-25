/**
 * The two catalogs must say the same things: a key missing from one silently
 * falls back to English (or renders the key itself), which no typecheck sees.
 */

import { expect, test } from 'bun:test';
import { JOB_STATUSES, PHASE_STATUSES, UPCOMING_PLATFORMS, MIGRATION_PLATFORMS } from '@move/shared-types';
import en from '../locales/en.json';
import es from '../locales/es.json';
import { LINKED_ACCOUNT_CALLBACK_ERRORS } from '../lib/linkedAccounts';

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
    'linkErrors.unknown',
    ...JOB_STATUSES.map((status) => `status.${status}`),
    ...PHASE_STATUSES.map((status) => `phaseStatus.${status}`),
    ...[...MIGRATION_PLATFORMS, ...UPCOMING_PLATFORMS].map((id) => `platformNames.${id}`),
  ];
  expect(required.filter((key) => !english.has(key))).toEqual([]);
});
