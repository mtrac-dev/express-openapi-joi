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
  docPath: '/widgets/{id}',
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
  docPath: '/widgets',
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
imported) just needs its import path repointed at this package -- the
call shape (`method`/`path`/`docPath`/`prefix`/`params`/`request`/
`responses`/`security`/`middleware`/`handler`) is unchanged.

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
