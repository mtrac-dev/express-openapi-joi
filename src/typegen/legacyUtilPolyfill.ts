import util from 'util';

/**
 * Restore `util.isArray` and `util.isBoolean`, which ts-json-schema-generator
 * still calls.
 *
 * @remarks
 * Newer Node versions removed both, and the generator fails with
 * `TypeError: util_1.isBoolean is not a function`. They're exact aliases of
 * `Array.isArray` and a `typeof` check, and are added only if missing. Import
 * this module before ts-json-schema-generator.
 */
const legacyUtil = util as typeof util & {
  isArray?: (v: unknown) => boolean;
  isBoolean?: (v: unknown) => boolean;
};

// Untested: every Node version in CI still has both functions.
/* c8 ignore start */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- this module restores the deprecated functions
legacyUtil.isArray ??= (value: unknown): value is unknown[] =>
  Array.isArray(value);
// eslint-disable-next-line @typescript-eslint/no-deprecated
legacyUtil.isBoolean ??= (value: unknown): value is boolean =>
  typeof value === 'boolean';
/* c8 ignore stop */
