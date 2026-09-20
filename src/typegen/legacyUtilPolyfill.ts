import util from 'util';

/**
 * ts-json-schema-generator's own internals (removeUnreachable.js,
 * allOfDefinition.js, AnnotatedTypeFormatter.js) call the long-deprecated
 * `util.isArray`/`util.isBoolean` -- removed outright in newer Node majors
 * (confirmed: `TypeError: util_1.isBoolean is not a function` under a
 * recent Node major that has dropped it). Both were always exact aliases
 * (Node's own docs: `util.isArray` === `Array.isArray`, `util.isBoolean`
 * === `typeof x === 'boolean'`), so restoring them is safe -- this isn't
 * reintroducing legacy behavior, just the two specific function names a
 * third-party dependency still expects. Only adds them if actually
 * missing, and only import this before importing ts-json-schema-generator
 * itself.
 */
const legacyUtil = util as typeof util & {
  isArray?: (v: unknown) => boolean;
  isBoolean?: (v: unknown) => boolean;
};

// Both bodies are only ever actually invoked on a Node major old enough to
// still be missing these -- confirmed present on every Node version this
// package tests/builds against, so `??=` never assigns (or calls) either
// one there.
/* c8 ignore start */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- restoring the deprecated name is the entire point of this file
legacyUtil.isArray ??= (value: unknown): value is unknown[] =>
  Array.isArray(value);
// eslint-disable-next-line @typescript-eslint/no-deprecated
legacyUtil.isBoolean ??= (value: unknown): value is boolean =>
  typeof value === 'boolean';
/* c8 ignore stop */
