# express-openapi-joi

Define an Express route and its Joi schemas once, and get request validation,
typed handlers and an OpenAPI 3.1 document from the same definition.

```ts
defineRoute(router, {
  method: 'post',
  path: '/:id',
  prefix: '/widgets',
  request: {
    params: Joi.object({ id: Joi.string().uuid().required() }),
    body: Joi.object<{ name: string }>({ name: Joi.string().required() }),
  },
  responses: { 201: { description: 'Created' } },
  handler: (req, res) => {
    // req.params.id and req.body.name are both typed
    res.status(201).json({ id: req.params.id, name: req.body.name });
  },
});
```

- [Install](#install)
- [Quick start](#quick-start)
- [Validation](#validation)
- [Paths](#paths)
- [Responses](#responses)
- [Reusable schemas](#reusable-schemas)
- [Security](#security)
- [Typed `res.locals`](#typed-reslocals)
- [Public and internal documents](#public-and-internal-documents)
- [Response schemas from TypeScript types](#response-schemas-from-typescript-types)
- [API](#api)
- [Development](#development)

## Install

```bash
npm install @mtrac/express-openapi-joi
```

`express` (4 or 5) and `joi` (17) are peer dependencies. Node 22 or later is
required. The package ships both ESM and CommonJS builds.

## Quick start

```ts
import express from 'express';
import Joi from 'joi';
import {
  createOpenApiRouter,
  defineRoute,
  routeRegistry,
  validationErrorHandler,
} from '@mtrac/express-openapi-joi';

const widgets = express.Router();

defineRoute(widgets, {
  method: 'get',
  path: '/',
  prefix: '/widgets',
  summary: 'List widgets',
  request: {
    query: Joi.object<{ limit: number }>({
      limit: Joi.number().integer().min(1).default(20),
    }),
  },
  responses: { 200: { description: 'A page of widgets' } },
  handler: (req, res) => {
    res.json({ limit: req.query.limit, items: [] });
  },
});

const app = express();
app.use(express.json());
app.use('/widgets', widgets);
app.use(
  '/openapi.json',
  createOpenApiRouter({ title: 'Widgets API', version: '1.0.0', routeRegistry })
);
app.use(validationErrorHandler);

app.listen(3000);
```

`GET /openapi.json` now serves the document, built once on first request and
cached.

`defineRoute` and `routeRegistry` are bound to a default, process-wide
registry. For a separate registry (one per test, or several APIs in one
process), create your own:

```ts
import { createRouteRegistry } from '@mtrac/express-openapi-joi';

const { defineRoute, routeRegistry, buildOpenApiDocument } =
  createRouteRegistry();
```

## Validation

Each `request` schema runs as middleware before your own `middleware` and
`handler`:

| Schema    | On success                                       | Unknown keys |
| --------- | ------------------------------------------------ | ------------ |
| `body`    | `req.body` is replaced with the validated value  | stripped     |
| `query`   | `req.query` is replaced with the validated value | stripped     |
| `params`  | validated only; `req.params` is left as is       | allowed      |
| `headers` | validated only; `req.headers` is left as is      | allowed      |

All errors are collected (`abortEarly: false`). Defaults and conversions from
your schema apply to `body` and `query`, so `req.query.limit` above is a
number.

`req.body` and `req.query` take their TypeScript types from the schema's type
parameter: `Joi.object<{ limit: number }>(...)`. Without one, Joi types the
value as `any`. `req.params` is typed from the `path` string instead (see
[Paths](#paths)).

A failed validation calls `next(err)` with Joi's `ValidationError`; nothing is
sent until an error handler responds. Mount `validationErrorHandler` after
your routes to respond `400 { message, details }`. Without an error handler,
Express's default one responds 500.

To use your own error format, handle the error yourself instead:

```ts
import type { ErrorRequestHandler } from 'express';
import Joi from 'joi';

const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (err instanceof Joi.ValidationError) {
    res.status(400).json({ code: 'invalid_request', errors: err.details });
    return;
  }
  next(err);
};
app.use(errorHandler);
```

Use `Joi.ValidationError` from the default import: `import { ValidationError }
from 'joi'` type-checks but is `undefined` at runtime under ESM.

## Paths

The document path is `prefix + path`, with Express params (`:id`, `:id?`,
`:id(\d+)`) written as `{id}`. Set `prefix` to the path the router is mounted
at, and leave it out for routes on `app` itself.

```ts
app.use('/carts/:cartId/items', items); // items = express.Router({ mergeParams: true })

defineRoute(items, {
  method: 'get',
  path: '/:itemId',
  prefix: '/carts/{cartId}/items',
  params: ['cartId', 'itemId'] as const,
  handler: (req, res) => {
    res.json({ cart: req.params.cartId, item: req.params.itemId });
  },
});
// documented as GET /carts/{cartId}/items/{itemId}
```

`req.params` is typed from the `path` literal. Pass `params` (with `as const`)
when inference can't see a param: one inherited through `mergeParams`, an
optional segment, or a regex constraint.

Wildcard paths (`*`) have no OpenAPI equivalent, and `defineRoute` throws for
them. Register those routes directly on the router.

## Responses

Document each status a route returns. `schema` is plain JSON Schema:

```ts
defineRoute(widgets, {
  method: 'get',
  path: '/:id',
  prefix: '/widgets',
  responses: {
    200: {
      description: 'The widget',
      schema: {
        type: 'object',
        properties: { id: { type: 'string' }, name: { type: 'string' } },
        required: ['id', 'name'],
      },
    },
    404: { description: 'No widget with that id' },
  },
  handler: getWidget,
});
```

A route with no `responses` documents none; no default `200` is added.

To check `handler` against the documented responses, use
`defineRoute.withResponses`. `res.status(code).json(body)` then only accepts
the type mapped to that status:

```ts
interface Widget {
  id: string;
  name: string;
}
interface NotFound {
  message: string;
}

defineRoute.withResponses<{ 200: Widget; 404: NotFound }>()(widgets, {
  method: 'get',
  path: '/:id',
  prefix: '/widgets',
  responses: {
    200: { description: 'The widget' },
    404: { description: 'No widget with that id' },
  },
  handler: (req, res) => {
    const widget = findWidget(req.params.id);
    if (!widget) {
      res.status(404).json({ message: 'Not found' });
      return;
    }
    res.status(200).json(widget);
  },
});
```

This is a compile-time check only. To document the response bodies from the
same types, see [Response schemas from TypeScript
types](#response-schemas-from-typescript-types).

For responses every route can return (say, a 500 from your error handler),
build the document with `commonResponses`. A route's own entry for the same
status wins.

```ts
const document = buildOpenApiDocument(routeRegistry, {
  title: 'Widgets API',
  version: '1.0.0',
  commonResponses: { 500: { description: 'Internal error' } },
});
app.get('/openapi.json', (req, res) => res.json(document));
```

## Reusable schemas

Give a Joi schema an id and it's emitted once under `components.schemas`, then
referenced with `$ref` wherever it's used:

```ts
const Address = Joi.object({
  line1: Joi.string().required(),
  city: Joi.string().required(),
}).id('Address');
```

Building the document throws if two different schemas share an id.

## Security

Pass your security schemes to the document, then declare which ones each
route accepts:

```ts
import { securedBy } from '@mtrac/express-openapi-joi';

const securitySchemes = {
  ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' },
  BearerAuth: { type: 'http', scheme: 'bearer' },
} as const;

// Tag a middleware once; every route using it documents ApiKeyAuth.
const requireApiKey = securedBy(apiKeyMiddleware, 'ApiKeyAuth');

defineRoute(widgets, {
  method: 'delete',
  path: '/:id',
  prefix: '/widgets',
  middleware: [requireApiKey],
  handler: deleteWidget,
});

// Or state it on the route. 'public' marks no-auth as one accepted option.
defineRoute(widgets, {
  method: 'get',
  path: '/:id',
  prefix: '/widgets',
  security: ['BearerAuth', 'public'],
  handler: getWidget,
});

app.use(
  '/openapi.json',
  createOpenApiRouter({
    title: 'Widgets API',
    version: '1.0.0',
    routeRegistry,
    securitySchemes,
  })
);
```

`securedBy` suits middleware that always enforces the same scheme. For
anything conditional, state `security` on the route. A route with neither
documents no security requirement.

Scheme names are plain strings by default, so a typo silently produces an
invalid document. Give your registry the set of names to make it a compile
error:

```ts
const { defineRoute, routeRegistry } = createRouteRegistry<
  'ApiKeyAuth' | 'BearerAuth'
>();
```

To restrict who can fetch the document itself, pass
`middleware: [requireApiKey]` (or any middleware) to `createOpenApiRouter`.

## Typed `res.locals`

Type your middleware as a `Provider<Locals>`, and `res.locals` in the handler
is typed from every provider in `middleware`:

```ts
import type { Provider } from '@mtrac/express-openapi-joi';

const loadUser: Provider<{ user: User }> = async (req, res, next) => {
  res.locals.user = await findUser(req.get('authorization'));
  next();
};

defineRoute(widgets, {
  method: 'get',
  path: '/mine',
  prefix: '/widgets',
  middleware: [loadUser],
  handler: (req, res) => {
    res.json(listWidgetsFor(res.locals.user)); // res.locals.user: User
  },
});
```

## Public and internal documents

Mark internal routes with `private: true`, then build a public document from
the filtered registry:

```ts
const internal = buildOpenApiDocument(routeRegistry, { title, version });
const external = buildOpenApiDocument(
  routeRegistry.filter((route) => !route.private),
  { title, version }
);
```

## Response schemas from TypeScript types

The `/typegen` entry point reads your route files and fills in each
`withResponses` route's response schemas from its TypeScript types:

```ts
import path from 'node:path';
import {
  applyDiscriminatorMappings,
  buildOpenApiDocument,
  routeRegistry,
} from '@mtrac/express-openapi-joi';
import { applyGeneratedResponseSchemas } from '@mtrac/express-openapi-joi/typegen';

const document = buildOpenApiDocument(routeRegistry, { title, version });

applyGeneratedResponseSchemas(
  document,
  [path.resolve('src/routes/widgets.ts')], // absolute paths to route files
  path.resolve('tsconfig.json')
);

// Optional: add discriminator.mapping to generated discriminated unions,
// so generated clients can tell the variants apart.
applyDiscriminatorMappings(
  document.components.schemas as Parameters<
    typeof applyDiscriminatorMappings
  >[0]
);
```

It reads TypeScript source, so run it where your sources and `tsconfig.json`
are available, for example in a build script that writes the document to a
file. It is a separate entry point so apps that don't use it never load the
TypeScript compiler.

Rules for `withResponses` calls:

- Write the map inline: `withResponses<{ 200: Widget[] }>()`. A named type
  for the whole map (`withResponses<WidgetResponses>()`) throws.
- Each status must map to a named type or interface (or an array of one),
  such as `Widget[]`. Inline object types, inline unions and generic
  instantiations throw; give them a named alias instead.
- Each status needs a `responses` entry, which supplies its description.
  A missing one throws.
- `prefix` and `path` must be string literals, or string constants declared
  in the file or imported from a relative path. Calls it can't resolve are
  skipped, with a message on `console.error`.
- A type with a `toJSON()` method is documented by what `toJSON()` returns,
  since that is what `res.json()` sends.
- `fileLooksLikeItUsesWithResponses(file)` is exported to help filter a
  directory listing down to route files.

## API

From `@mtrac/express-openapi-joi`:

| Export                                          | Purpose                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `defineRoute(router, def)`                      | Register a route on the default registry                                                 |
| `defineRoute.withResponses<Map>()(router, def)` | Same, with `res` checked against a status → body type map                                |
| `routeRegistry`                                 | The default registry's routes                                                            |
| `createRouteRegistry<Schemes>()`                | A separate `{ defineRoute, routeRegistry, buildOpenApiDocument }`                        |
| `buildOpenApiDocument(routes, options)`         | Build the document (`title`, `version`, `servers`, `securitySchemes`, `commonResponses`) |
| `createOpenApiRouter(options)`                  | Router serving the document at its mount path                                            |
| `validationErrorHandler`                        | Error middleware responding `400` to validation failures                                 |
| `securedBy(middleware, scheme)`                 | Tag middleware with the security scheme it enforces                                      |
| `applyDiscriminatorMappings(schemas)`           | Add `discriminator.mapping` to discriminated unions                                      |
| `pathToDocSegment(path)`                        | Convert an Express path to OpenAPI syntax (`/:id` → `/{id}`)                             |
| `Provider<Locals>`, `ProviderLocals<T>`         | Types for middleware that sets `res.locals`                                              |
| `RouteDef`, `OpenApiDocument`, `SecurityScheme` | Types                                                                                    |

From `@mtrac/express-openapi-joi/typegen`: `applyGeneratedResponseSchemas`,
`fileLooksLikeItUsesWithResponses`, and the lower-level `createFileProgram`
and `generateResponseSchema`.

Every `defineRoute` option is documented in its type, so your editor shows
it on hover.

## Development

```bash
nvm use
npm install
npm run lint
npm test        # type-checks, then runs the tests with coverage
npm run build   # writes dist/esm and dist/cjs
```

The source is ESM, compiled twice: `tsconfig.esm.json` and
`tsconfig.cjs.json` both extend `tsconfig.base.json`. `tsconfig.json` covers
`src` and `test` for type-checking, linting and tests, and is not used for
the build.

## License

MIT
