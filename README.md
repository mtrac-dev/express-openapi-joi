# express-openapi-joi

Generates OpenAPI 3 documents from Express routes validated with Joi.

## Status

Core generator is in place: `defineRoute` registers an Express route and its
Joi schemas in one call against the library's default registry, and
`buildOpenApiDocument`/`createOpenApiRouter` build and serve the resulting
OpenAPI 3.1 document (paths, path/query/header parameters, request bodies,
responses, and security schemes, merged correctly across routes that share a
docPath+method). `createRouteRegistry()` is also available directly, for an
isolated registry instead of the default shared one.

The document's types come from `openapi3-ts/oas31` (a real, maintained
OpenAPI 3.1 type package), not hand-rolled interfaces. A Joi schema marked
with `.id('Name')` is emitted as `$ref: '#/components/schemas/Name'` plus a
`components.schemas.Name` entry, instead of the same shape repeated inline
at every call site that reuses it -- reusing the same id across two
differently-shaped schemas throws at document-build time rather than
silently documenting one and discarding the other. `operationId` defaults
to `handler`'s own function name (falling back to a derived
method+docPath name, e.g. `getWidgetsId`, when the handler is anonymous or
its inferred name is just the literal `"handler"` -- see
`RouteDef.operationId`'s own JSDoc for the full fallback chain and its one
documented gap). `buildOpenApiDocument` also takes an optional
`commonResponses` (merged into every operation, e.g. the 400/404/500 an
app-wide error handler can produce regardless of which route ran).

`defineRoute.withResponses<{ 200: Widget }>()(router, {...})` -- an
alternative to plain `defineRoute` -- type-checks `handler`'s `res` against
a per-status response map (`res.status(200).json(...)` only accepts a
`Widget` there), and, paired with the separate `./typegen` subpath export,
generates `responses[status].schema` from those same TypeScript types
instead of hand-writing JSON Schema for them. See "Typed responses" and
"Generating response schemas from TypeScript" below.

See `src/index.ts` for the full public API.

## Installation

```bash
npm install @mtrac/express-openapi-joi
```

`express` and `joi` are peer dependencies — install whichever versions your
project already uses.

## Usage

Import `defineRoute` and `routeRegistry` directly -- most apps only need one,
process-wide registry, and these are bound to the library's default instance
already. Register routes against it with `defineRoute`, then serve the
generated document with `createOpenApiRouter`:

```ts
import express from 'express';
import Joi from 'joi';
import {
  defineRoute,
  routeRegistry,
  createOpenApiRouter,
} from '@mtrac/express-openapi-joi';

const widgetsRouter = express.Router();
defineRoute(widgetsRouter, {
  method: 'post',
  path: '/:id',
  prefix: '/widgets',
  summary: 'Create a widget',
  request: {
    params: Joi.object({ id: Joi.string().uuid().required() }),
    body: Joi.object({ name: Joi.string().required() }),
  },
  handler: (req, res) => {
    // req.params.id and req.body.name are typed from the schemas above.
    res.status(201).json({ id: req.params.id, name: req.body.name });
  },
});

const app = express();
app.use(express.json());
app.use('/widgets', widgetsRouter);
app.use(
  '/openapi.json',
  createOpenApiRouter({
    title: 'my-service',
    version: '1.0.0',
    routeRegistry,
    // Optional: gate the document the same way any other internal route
    // is gated in this app (an API-key check, auth middleware, ...).
    middleware: [myApiKeyAuthMiddleware],
  })
);
```

### Security schemes

This library doesn't define any security schemes itself -- pass your own
`components.securitySchemes` map, and either tag the enforcing middleware
with `securedBy` (for a simple, fixed check) or state `security` explicitly
on the route:

```ts
import { securedBy, createOpenApiRouter } from '@mtrac/express-openapi-joi';

const SECURITY_SCHEMES = {
  ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' },
};

const apiKeyAuth = securedBy(myApiKeyAuthMiddleware, 'ApiKeyAuth');

defineRoute(widgetsRouter, {
  method: 'get',
  path: '/',
  prefix: '/widgets',
  middleware: [apiKeyAuth], // security: ['ApiKeyAuth'] is inferred automatically
  handler: (_req, res) => res.status(200).json([]),
});

app.use(
  '/openapi.json',
  createOpenApiRouter({
    title: 'my-service',
    version: '1.0.0',
    routeRegistry,
    securitySchemes: SECURITY_SCHEMES,
  })
);
```

### Isolated registries

Reach for `createRouteRegistry()` instead of the default `defineRoute`/
`routeRegistry` export when you genuinely need more than one registry in a
single process -- every test in this repo does exactly that, so each test
gets its own empty registry with no cleanup required between tests:

```ts
import { createRouteRegistry } from '@mtrac/express-openapi-joi';

const { defineRoute, routeRegistry, buildOpenApiDocument } =
  createRouteRegistry();
```

### Typed responses

Express's own `Response<ResBody>.status(code)` returns the same
`Response<ResBody>` regardless of `code` -- there's no built-in way to tie
a specific status literal to its own response shape. `defineRoute.withResponses<Responses>()`
is an alternative to plain `defineRoute` that fixes that: it's curried
(call it with the response map first, then call the function it returns
exactly like `defineRoute`) because TypeScript stops inferring every
other type parameter the instant any explicit type argument is given, and
currying isolates `Responses` into a call with nothing else to infer.

```ts
import { defineRoute } from '@mtrac/express-openapi-joi';

interface Widget {
  id: string;
  name: string;
}
interface NotFound {
  message: string;
}

defineRoute.withResponses<{ 200: Widget; 404: NotFound }>()(widgetsRouter, {
  method: 'get',
  path: '/:id',
  prefix: '/widgets',
  summary: 'Get a widget',
  responses: {
    200: { description: 'The widget' },
    404: { description: 'No widget with that id' },
  },
  handler: (req, res) => {
    // res.status(200).json(...) only accepts a Widget here; res.status(404)
    // only accepts a NotFound. A computed status code (no .status() call
    // narrowing it to a literal) falls back to the full union, same as a
    // plain defineRoute handler always has.
    res.status(200).json({ id: req.params.id, name: 'thing' });
  },
});
```

This is purely a compile-time check on `handler` -- `responses[status].schema`
still needs either a hand-written `schema` on the `responses` entry above, or
the separate `./typegen` subpath below, to actually document the response
body's shape.

### Generating response schemas from TypeScript (`./typegen`)

A separate subpath export -- not part of the main package entry point,
since it pulls in `ts-json-schema-generator` and the TypeScript compiler
API, real weight a consumer only using `defineRoute`/`buildOpenApiDocument`
shouldn't have to carry. Generates `responses[status].schema` from a
`withResponses<>` call's own response types, the same "the TypeScript type
is the source of truth" idea `.id()` already gives request bodies via
joi-to-json, as a post-process on an already-built document:

```ts
import { applyGeneratedResponseSchemas } from '@mtrac/express-openapi-joi/typegen';

// After buildOpenApiDocument():
applyGeneratedResponseSchemas(
  document,
  // Absolute paths to every file that might contain a
  // defineRoute.withResponses<>() call -- this module doesn't scan a
  // directory itself; walk your own routes directory and filter with the
  // re-exported fileLooksLikeItUsesWithResponses if you want that
  // convenience.
  routeFiles,
  // Absolute path to the tsconfig.json whose compilerOptions resolve
  // those files' own types.
  tsconfigPath
);
```

Every `withResponses<{...}>` value must be a plain named type/interface
reference (or an array of one) -- an inline union, an inline object
literal, or a generic instantiation written directly throws instead of
silently generating no schema (or the wrong one); give it its own
concrete, non-generic named type alias instead. A type with a `toJSON`
method (checked structurally, not by name) generates from that method's
own return type instead of the type's own shape, since that's what
`res.json()` actually sends over the wire.

Runs identically under both ESM and CJS, same as every other export in
this package -- reaching into `ts-json-schema-generator`'s own nested
`typescript` install (needed so both this module and it agree on the same
`ts.SyntaxKind` numbering) needs `require.resolve`'s `paths` option, which
has no ESM-native equivalent; this is handled internally via
`module.createRequire`, not something a caller needs to think about.

### Swapping into an app that already hand-rolls this (e.g. registry.ts/security.ts/openapiRouter.ts)

If an app already has its own local `defineRoute`/`buildOpenApiDocument`
implementation, the usual shape after adopting this package is:

- **`registry.ts`** — delete it. Every router file that imported
  `defineRoute`/`routeRegistry` from it can import those directly from this
  package instead (`export { defineRoute, routeRegistry } from
'@mtrac/express-openapi-joi';` there too, if you'd rather keep the
  existing import path unchanged everywhere else).
- **`security.ts`** — keep the app's own `SECURITY_SCHEMES` const (this
  package doesn't know your schemes), but import `securedBy`/
  `inferSecurity`/`mergeSecurity` and the `SecurityScheme`/
  `SecurityRequirement`/`SecurityRequirementObject` types from this package
  instead of defining them locally.
- **`openapiRouter.ts`** — replace the hand-rolled router with
  `createOpenApiRouter({ title, version, routeRegistry, securitySchemes:
SECURITY_SCHEMES, middleware: [yourExistingAuthMiddleware] })`.

Every other router file (wherever `defineRoute`/`RouteDef`/`Provider` are
imported) just needs its import path repointed at this package. Three
things changed since the last time this section was updated -- one of
them (`docPath`) DOES need call-site edits, the other two don't:

- **`docPath` is gone.** `RouteDef` no longer has a `docPath` field at
  all -- `prefix` is now the only way to give a route's OpenAPI path
  context, and it's always combined with `path` (`prefix + path`,
  translating this route's own `:name`/`:name?`/`:name(regex)` segments
  to `{name}`) to produce the document path. Concretely, in every real
  router file in the original app today, `docPath` is hand-computed as exactly
  `prefix + translated-path` via a string constant declared once per
  file (e.g. `cartRouter.ts`'s `const cartDocPath = '/carts/{cart_id}'`,
  reused as `docPath: `${cartDocPath}/migrate`` alongside
  `path: '/:cart_id/migrate'`) -- so the conversion is mechanical:
  - If `docPath` is just `path` translated verbatim (no other router
    mounted in front of it) -- delete the `docPath` line entirely, don't
    add `prefix`. (Registering directly on `app`, or a router mounted at
    the app's absolute root, needs nothing here.)
  - Otherwise, replace that per-file `docPath` constant (e.g.
    `cartDocPath`) with a `prefix` value of the same string, and pass
    `prefix: cartDocPath` (or inline the string) on every `defineRoute`
    call in that file instead of `docPath`. Delete the now-unused
    `docPath` constant declarations (`cartDocPath`/`itemsDocPath`/
    `itemDocPath`/etc.) once nothing references them.
  - `noteRouter.ts`'s mergeParams-derived-param case (`cart_id`/
    `item_id` from the parent mount, invisible to this router's own
    relative `path`) converts the same way: its existing
    `noteDocPath` constant -- already exactly `prefix + path`,
    since `path` there is just `'/'` -- becomes the `prefix` value
    directly; keep the existing `params` override (or add one) for
    typing `req.params`, same as today.
  - A registration that throws `resolves to an empty docPath` after this
    conversion means a route ended up with neither a `prefix` nor a
    non-root `path` -- give it one or the other.
- **Schemas marked with `.id()`** (if the prototype's schemas use it) now
  produce a real `$ref`/`components.schemas` entry instead of the shape
  being inlined at every call site. If two different Joi schemas
  accidentally reuse the same `.id()`, building the document now throws
  immediately naming the collision, rather than silently documenting
  whichever one happened to be seen first -- if that throws once you swap
  in, it's surfacing a real pre-existing ambiguity, not a regression.
- **`operationId`** no longer needs an explicit override just to avoid two
  anonymous-handler routes colliding: an inline `handler: (req, res) =>
{...}` (JS infers the property key `"handler"` as that function's own
  name) used to mean every such route got the same, useless
  `operationId: "handler"`. It's now either the handler's own real
  function name, or -- when that's not usable -- a name derived from
  method+docPath (e.g. `getWidgetsId`), so operationId collisions across
  genuinely different routes should be rarer than they were, without
  anything needing to change in the router files themselves.

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
shared `tsconfig.base.json`. Source imports use explicit `.ts` extensions
(e.g. `import { foo } from './foo.ts'`), rewritten to the right output
extension per build via `rewriteRelativeImportExtensions`, so both the
NodeNext (ESM) and Node10 (CJS) module resolution modes resolve and emit
correctly from the same source tree. `npm run build` writes a
`{"type":"commonjs"}` marker into `dist/cjs` so Node treats that output as
CommonJS regardless of the package-level `"type": "module"`.

`tsconfig.json` (the un-suffixed one) is not used for building — it's the
project ESLint, editors, and Mocha (via `ts-node/esm`) type-check against,
and it includes both `src` and `test`.
