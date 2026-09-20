import { createRequire } from 'module';
import path from 'path';
import type ts from 'typescript';

/**
 * `ts-json-schema-generator`'s internal parser classes (NodeParser/
 * ChainNodeParser/TypeLiteralNodeParser/etc.) compare `node.kind` against
 * ITS OWN bundled `ts.SyntaxKind` enum -- confirmed empirically that
 * SyntaxKind's numeric ordinals shift between TypeScript versions as new
 * kinds are added, so handing the library a `ts.Program`/AST built from
 * some OTHER `typescript` install (a consumer's own real one, say) doesn't
 * throw -- it just silently fails to recognize every node kind it's given
 * (`findNamedNode` reports "No root type found" for a type that's plainly
 * there).
 *
 * So both this module's own AST walk (applyGeneratedResponseSchemas.ts)
 * and schema generation (schemaGenerator.ts) build their `ts.Program` via
 * THIS SAME nested `typescript` -- never mix nodes obtained from two
 * different `typescript` installs.
 *
 * Resolved via `require.resolve`'s `paths` option (starting the module
 * search from ts-json-schema-generator's own resolved location, itself
 * resolved from the current working directory) rather than a hardcoded
 * nested path, so this keeps working across npm's own hoisting decisions
 * (which vary by install) and across future version bumps.
 *
 * `require.resolve(..., { paths })` has no ESM-native equivalent, but
 * `module.createRequire(filename)` produces a real `require` function that
 * supports it identically under either module system, given a real
 * anchor. `process.cwd()` -- not `__filename`/`import.meta.url` (this
 * module's own location) -- is that anchor: it's available as a plain
 * runtime value under both CommonJS and a real ESM loader with no
 * conditional needed, whereas `__filename` doesn't exist under ESM and
 * `import.meta.url` can't appear as literal syntax in a file that's also
 * compiled to CommonJS (TS1343) -- confirmed directly against this
 * project's own tsconfig.cjs.json. This assumes `ts-json-schema-generator`
 * is resolvable via an ordinary node_modules directory walk-up from
 * wherever a consumer's build script is actually run from (true for
 * typical npm installs; an isolated-by-default installer like pnpm's
 * strict mode could break this, same as it would for `require.resolve`
 * from any fixed file location).
 *
 * Typed against the real `typescript` package's own .d.ts purely for
 * editor/compiler convenience in the rest of this directory's code --
 * every API this module's callers actually use (createProgram,
 * forEachChild, the `is*` node-kind guards, SyntaxKind, NodeBuilderFlags,
 * getPropertyOfType, typeToTypeNode, ...) is stable, long-standing
 * TypeScript compiler API surface, so the real risk is limited to the
 * type *declarations* claiming slightly more than the nested version
 * actually provides, not to any runtime call this module makes.
 */
const cwdRequire = createRequire(path.join(process.cwd(), 'noop.js'));
const nestedTsPath = cwdRequire.resolve('typescript', {
  paths: [cwdRequire.resolve('ts-json-schema-generator')],
});
const nestedTs = cwdRequire(nestedTsPath) as typeof ts;

export default nestedTs;
