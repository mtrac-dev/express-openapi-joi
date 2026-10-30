import { createRequire } from 'module';
import path from 'path';
import type ts from 'typescript';

/**
 * The `typescript` package that ts-json-schema-generator depends on.
 *
 * @remarks
 * ts-json-schema-generator compares `node.kind` against its own
 * `typescript`'s `SyntaxKind`, whose values change between TypeScript
 * versions. Given a program from another `typescript` install, it doesn't
 * throw, but recognizes no nodes and reports "No root type found". Build
 * every program and AST that reaches the generator with this module.
 *
 * The package is resolved from ts-json-schema-generator's location, which is
 * found from `process.cwd()`, so the lookup works however npm hoists it.
 * `process.cwd()` is used because `__filename` doesn't exist in ESM, and
 * `import.meta.url` can't be compiled to CommonJS. A strict pnpm install,
 * where the generator isn't reachable from the working directory, breaks the
 * lookup.
 *
 * It's typed as this project's own `typescript`. The compiler APIs used here
 * are stable across versions.
 */
const cwdRequire = createRequire(path.join(process.cwd(), 'noop.js'));
const nestedTsPath = cwdRequire.resolve('typescript', {
  paths: [cwdRequire.resolve('ts-json-schema-generator')],
});
const nestedTs = cwdRequire(nestedTsPath) as typeof ts;

export default nestedTs;
