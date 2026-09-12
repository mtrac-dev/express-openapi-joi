# express-openapi-joi

Generates OpenAPI 3 documents from Express routes validated with Joi.

## Status

Early scaffolding — no generator logic yet. This repo currently provides the
project foundation (TypeScript, lint, test, and CI setup) that the generator
will be built on top of.

## Installation

```bash
npm install @mtrac/express-openapi-joi
```

`express` and `joi` are peer dependencies — install whichever versions your
project already uses.

## Development

```bash
nvm use
npm install
npm run build      # compiles dist/esm and dist/cjs
npm run lint
npm test
```

### Dual ESM/CJS output

The package is authored as ESM (`"type": "module"`) but is built twice —
once for ESM consumers and once for CJS consumers — using separate
`tsconfig.esm.json` / `tsconfig.cjs.json` projects that both extend the
shared `tsconfig.base.json`. Source imports use explicit `.js` extensions
(e.g. `import { foo } from './foo.js'`) so both the NodeNext (ESM) and
Node10 (CJS) module resolution modes can resolve them back to the `.ts`
source files. `npm run build` writes a `{"type":"commonjs"}` marker into
`dist/cjs` so Node treats that output as CommonJS regardless of the
package-level `"type": "module"`.

`tsconfig.json` (the un-suffixed one) is not used for building — it's the
project ESLint, editors, and Mocha (via `ts-node/esm`) type-check against,
and it includes both `src` and `test`.
