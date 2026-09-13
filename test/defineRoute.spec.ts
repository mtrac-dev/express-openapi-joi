import express from 'express';
import Joi from 'joi';
import { expect } from 'chai';

import { createRouteRegistry } from '../src/defineRoute.ts';
import type { Provider } from '../src/provider.ts';
import { testRequest } from './helpers/request.ts';

describe('UNIT: defineRoute', () => {
  it('infers path params from a string-literal path, with no explicit Params argument', async () => {
    const { defineRoute } = createRouteRegistry();
    const router = express.Router();
    defineRoute(router, {
      method: 'get',
      path: '/:id',
      docPath: '/widgets/{id}',
      handler: (req, res) => {
        // Compile-time check: req.params.id must type-check as string with
        // no explicit Params generic, purely from the '/:id' path literal.
        const { id } = req.params;
        res.status(200).json({ id });
      },
    });

    const app = express();
    app.use('/widgets', router);

    const res = await testRequest(app).get('/widgets/abc');

    expect(res.statusCode).to.equal(200);
    expect(res.body).to.eql({ id: 'abc' });
  });

  it('validates the body against a Joi schema, matching bodyValidator behavior', async () => {
    const { defineRoute } = createRouteRegistry();
    const router = express.Router();
    const schema = Joi.object<{ name: string }>({
      name: Joi.string().required(),
    });

    defineRoute(router, {
      method: 'post',
      path: '/',
      docPath: '/widgets',
      request: { body: schema },
      handler: (req, res) => {
        res.status(201).json({ name: req.body.name });
      },
    });

    const app = express();
    app.use(express.json());
    app.use('/widgets', router);
    const request = testRequest(app);

    const valid = await request.post('/widgets').send({ name: 'thing' });
    expect(valid.statusCode).to.equal(201);
    expect(valid.body).to.eql({ name: 'thing' });

    const invalid = await request.post('/widgets').send({});
    expect(invalid.statusCode).to.equal(400);
  });

  it('runs validators before middleware, so a validation failure wins over a middleware that would otherwise short-circuit', async () => {
    const { defineRoute } = createRouteRegistry();
    const router = express.Router();
    const notFoundMiddleware: express.RequestHandler = (_req, res) => {
      res.status(404).json({});
    };

    defineRoute(router, {
      method: 'post',
      path: '/',
      docPath: '/widgets',
      request: { body: Joi.object({ name: Joi.string().required() }) },
      middleware: [notFoundMiddleware],
      handler: (_req, res) => res.status(201).json({}),
    });

    const app = express();
    app.use(express.json());
    app.use('/widgets', router);

    const res = await testRequest(app).post('/widgets').send({});

    expect(res.statusCode).to.equal(400);
  });

  it('mergeParams-derived params not visible in the router-relative path can be typed via `params`, not a cast', async () => {
    const { defineRoute, routeRegistry } = createRouteRegistry();
    const router = express.Router({ mergeParams: true });

    defineRoute(router, {
      method: 'delete',
      path: '/',
      prefix: '/carts/{cartId}/items/{itemId}',
      params: ['cartId', 'itemId'] as const,
      handler: (req, res) => {
        // '/' alone has nothing for ExtractRouteParams to find -- cartId/itemId
        // come from the parent mount below, so `params` overrides inference
        // instead of needing a cast.
        const { cartId, itemId } = req.params;
        res.status(200).json({ cartId, itemId });
      },
    });

    const app = express();
    app.use('/carts/:cartId/items/:itemId', router);

    const res = await testRequest(app).delete('/carts/p1/items/i1');

    expect(res.statusCode).to.equal(200);
    expect(res.body).to.eql({ cartId: 'p1', itemId: 'i1' });
    expect(routeRegistry.at(-1)).to.include({
      docPath: '/carts/{cartId}/items/{itemId}',
    });
  });

  // Express 4's path-to-regexp accepted inline regex constraints
  // (`:name(pattern)`) and a trailing `?` modifier directly in the path
  // string; Express 5's router no longer parses either at all (it throws
  // synchronously on registration, even for a bare `:name?`) -- newer
  // syntax uses `{...}` optional groups instead. defineRoute's own
  // pathToDocSegment translation still has to handle the legacy syntax
  // for an Express-4 consumer, so these use a minimal stub router (just a
  // recorded method call, not real path-to-regexp parsing) to test that
  // translation without depending on which Express major is installed.
  function stubRouter(): express.Router {
    return { get: () => undefined } as unknown as express.Router;
  }

  it('an inline regex-constrained param can be typed via `params`, not a cast', () => {
    const { defineRoute, routeRegistry } = createRouteRegistry();

    defineRoute(stubRouter(), {
      method: 'get',
      path: '/:slug([0-9a-z-]+)',
      prefix: '/widgets',
      params: ['slug'] as const,
      handler: (req, res) => {
        const { slug } = req.params;
        res.status(200).json({ slug });
      },
    });

    expect(routeRegistry.at(-1)).to.include({ docPath: '/widgets/{slug}' });
  });

  it('derives docPath via prefix for a segment that is both regex-constrained and optional', () => {
    const { defineRoute, routeRegistry } = createRouteRegistry();

    defineRoute(stubRouter(), {
      method: 'get',
      path: '/:slug([0-9a-z-]+)?',
      prefix: '/widgets',
      params: ['slug'] as const,
      handler: (req, res) => {
        const { slug } = req.params;
        res.status(200).json({ slug });
      },
    });

    // Express's real modifier order is constraint-then-optional -- a
    // regex matching `?` before the constraint group would leave a
    // dangling, un-replaced `?` in the derived docPath.
    expect(routeRegistry.at(-1)).to.include({ docPath: '/widgets/{slug}' });
  });

  it('throws at registration time when neither docPath nor prefix is given', () => {
    const { defineRoute } = createRouteRegistry();
    const router = express.Router();

    expect(() => {
      defineRoute(router, {
        method: 'get',
        path: '/',
        handler: (_req, res) => res.status(200).json([]),
      });
    }).to.throw(/needs either docPath or prefix/);
  });

  it('infers Locals from Provider<L> middleware, the same merging a provideAll()-style combinator does for the type system', async () => {
    const { defineRoute } = createRouteRegistry();
    const router = express.Router();

    const widgetProvider: Provider<{ widget: { id: string } }> = (
      req,
      res,
      next
    ) => {
      res.locals.widget = { id: req.params.id };
      next();
    };

    defineRoute(router, {
      method: 'get',
      path: '/:id',
      docPath: '/widgets/{id}',
      middleware: [widgetProvider],
      handler: (req, res) => {
        // Compile-time check: res.locals.widget type-checks with no cast,
        // inferred purely from widgetProvider's Provider<{widget:...}> type.
        const { widget } = res.locals;
        res.status(200).json(widget);
      },
    });

    const app = express();
    app.use('/widgets', router);

    const res = await testRequest(app).get('/widgets/abc');

    expect(res.statusCode).to.equal(200);
    expect(res.body).to.eql({ id: 'abc' });
  });

  it('validates query params against a Joi schema when request.query is given', async () => {
    const { defineRoute } = createRouteRegistry();
    const router = express.Router();
    defineRoute(router, {
      method: 'get',
      path: '/',
      docPath: '/widgets',
      request: { query: Joi.object({ q: Joi.string().required() }) },
      handler: (_req, res) => res.status(200).json([]),
    });

    const app = express();
    app.use('/widgets', router);
    const request = testRequest(app);

    expect((await request.get('/widgets?q=thing')).statusCode).to.equal(200);
    expect((await request.get('/widgets')).statusCode).to.equal(400);
  });

  it('validates headers against a Joi schema when request.headers is given', async () => {
    const { defineRoute } = createRouteRegistry();
    const router = express.Router();
    defineRoute(router, {
      method: 'get',
      path: '/',
      docPath: '/widgets',
      request: {
        headers: Joi.object({ 'x-tenant': Joi.string().required() }).unknown(
          true
        ),
      },
      handler: (_req, res) => res.status(200).json([]),
    });

    const app = express();
    app.use('/widgets', router);
    const request = testRequest(app);

    expect(
      (await request.get('/widgets').set('x-tenant', 'acme')).statusCode
    ).to.equal(200);
    expect((await request.get('/widgets')).statusCode).to.equal(400);
  });

  it('validates params against a Joi schema when request.params is given', async () => {
    const { defineRoute } = createRouteRegistry();
    const router = express.Router();
    defineRoute(router, {
      method: 'get',
      path: '/:id',
      docPath: '/widgets/{id}',
      request: { params: Joi.object({ id: Joi.string().uuid().required() }) },
      handler: (_req, res) => res.status(200).json([]),
    });

    const app = express();
    app.use('/widgets', router);
    const request = testRequest(app);

    expect(
      (await request.get('/widgets/9f7f9b1a-3f2f-4b3f-9b1a-3f2f4b3f9b1a'))
        .statusCode
    ).to.equal(200);
    expect((await request.get('/widgets/not-a-uuid')).statusCode).to.equal(400);
  });

  it("defaults operationId to the handler's own function name", () => {
    const { defineRoute, routeRegistry } = createRouteRegistry();
    const router = express.Router();
    defineRoute(router, {
      method: 'get',
      path: '/',
      docPath: '/widgets',
      handler: function listWidgets(_req, res) {
        res.status(200).json([]);
      },
    });

    expect(routeRegistry.at(-1)).to.include({ operationId: 'listWidgets' });
  });

  it('overrides the handler-name default when operationId is given explicitly', () => {
    const { defineRoute, routeRegistry } = createRouteRegistry();
    const router = express.Router();
    defineRoute(router, {
      method: 'get',
      path: '/',
      docPath: '/widgets',
      operationId: 'listAllWidgets',
      handler: function listWidgets(_req, res) {
        res.status(200).json([]);
      },
    });

    expect(routeRegistry.at(-1)).to.include({ operationId: 'listAllWidgets' });
  });

  it('leaves operationId undefined for an anonymous handler with no explicit override', () => {
    const { defineRoute, routeRegistry } = createRouteRegistry();
    const router = express.Router();
    // Array indirection defeats JS's name inference for an anonymous
    // function expression -- passed directly as `handler: (req, res) => {}`,
    // it would otherwise infer the property key ("handler") as its name.
    const [anonymousHandler] = [
      (_req: express.Request, res: express.Response) =>
        res.status(200).json([]),
    ];

    defineRoute(router, {
      method: 'get',
      path: '/',
      docPath: '/widgets',
      handler: anonymousHandler,
    });

    expect(routeRegistry.at(-1)?.operationId).to.be.undefined;
  });

  it('pushes the route definition into routeRegistry for later OpenAPI-document generation', () => {
    const { defineRoute, routeRegistry } = createRouteRegistry();
    const router = express.Router();
    defineRoute(router, {
      method: 'get',
      path: '/',
      docPath: '/widgets',
      summary: 'List widgets',
      handler: (_req, res) => res.status(200).json([]),
    });

    expect(routeRegistry).to.have.lengthOf(1);
    expect(routeRegistry.at(-1)).to.include({
      method: 'get',
      docPath: '/widgets',
      summary: 'List widgets',
    });
  });

  it('binds buildOpenApiDocument to its own registry', () => {
    const { defineRoute, buildOpenApiDocument } = createRouteRegistry();
    defineRoute(express.Router(), {
      method: 'get',
      path: '/',
      docPath: '/widgets',
      summary: 'List widgets',
      handler: (_req, res) => res.status(200).json([]),
    });

    const doc = buildOpenApiDocument({ title: 'test-api', version: '1.0.0' });

    expect(doc.paths['/widgets'].get).to.include({ summary: 'List widgets' });
  });

  it('gives each call its own isolated registry, not a shared singleton', () => {
    const first = createRouteRegistry();
    const second = createRouteRegistry();

    first.defineRoute(express.Router(), {
      method: 'get',
      path: '/',
      docPath: '/widgets',
      handler: (_req, res) => res.status(200).json([]),
    });

    expect(first.routeRegistry).to.have.lengthOf(1);
    expect(second.routeRegistry).to.have.lengthOf(0);
  });
});
