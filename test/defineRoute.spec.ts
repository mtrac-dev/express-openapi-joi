import express from 'express';
import Joi from 'joi';
import { expect } from 'chai';

import { createRouteRegistry } from '../src/defineRoute.ts';
import type { Provider } from '../src/provider.ts';
import { validationErrorHandler } from '../src/validators.ts';
import { testRequest } from './helpers/request.ts';

describe('UNIT: defineRoute', () => {
  it('infers path params from a string-literal path, with no explicit Params argument', async () => {
    const { defineRoute } = createRouteRegistry();
    const router = express.Router();
    defineRoute(router, {
      method: 'get',
      path: '/:id',
      prefix: '/widgets',
      handler: (req, res) => {
        // Compile-time check: req.params.id is a string, inferred from '/:id'.
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

  it('registers directly on an Express app, not just a Router', async () => {
    const { defineRoute } = createRouteRegistry();
    const app = express();

    defineRoute(app, {
      method: 'get',
      path: '/widgets/:id',
      handler: (req, res) => {
        const { id } = req.params;
        res.status(200).json({ id });
      },
    });

    const res = await testRequest(app).get('/widgets/abc');

    expect(res.statusCode).to.equal(200);
    expect(res.body).to.eql({ id: 'abc' });
  });

  it('validates the body against a Joi schema', async () => {
    const { defineRoute } = createRouteRegistry();
    const router = express.Router();
    const schema = Joi.object<{ name: string }>({
      name: Joi.string().required(),
    });

    defineRoute(router, {
      method: 'post',
      path: '/',
      prefix: '/widgets',
      request: { body: schema },
      handler: (req, res) => {
        res.status(201).json({ name: req.body.name });
      },
    });

    const app = express();
    app.use(express.json());
    app.use('/widgets', router);
    app.use(validationErrorHandler);
    const request = testRequest(app);

    const valid = await request.post('/widgets').send({ name: 'thing' });
    expect(valid.statusCode).to.equal(201);
    expect(valid.body).to.eql({ name: 'thing' });

    const invalid = await request.post('/widgets').send({});
    expect(invalid.statusCode).to.equal(400);
  });

  it('runs validators before middleware', async () => {
    const { defineRoute } = createRouteRegistry();
    const router = express.Router();
    const notFoundMiddleware: express.RequestHandler = (_req, res) => {
      res.status(404).json({});
    };

    defineRoute(router, {
      method: 'post',
      path: '/',
      prefix: '/widgets',
      request: { body: Joi.object({ name: Joi.string().required() }) },
      middleware: [notFoundMiddleware],
      handler: (_req, res) => res.status(201).json({}),
    });

    const app = express();
    app.use(express.json());
    app.use('/widgets', router);
    app.use(validationErrorHandler);

    const res = await testRequest(app).post('/widgets').send({});

    expect(res.statusCode).to.equal(400);
  });

  it('types params inherited through mergeParams with `params`', async () => {
    const { defineRoute, routeRegistry } = createRouteRegistry();
    const router = express.Router({ mergeParams: true });

    defineRoute(router, {
      method: 'delete',
      path: '/',
      prefix: '/carts/{cartId}/items/{itemId}',
      params: ['cartId', 'itemId'] as const,
      handler: (req, res) => {
        // cartId and itemId come from the parent mount, so `params` types them.
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

  // Express 5 rejects `:name(pattern)` and `:name?` at registration, but
  // pathToDocSegment still translates them for Express 4 apps. A stub router
  // tests the translation with either Express version installed.
  function stubRouter(): express.Router {
    return { get: () => undefined } as unknown as express.Router;
  }

  it('types a regex-constrained param with `params`', () => {
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

    // Express puts the constraint before the optional marker.
    expect(routeRegistry.at(-1)).to.include({ docPath: '/widgets/{slug}' });
  });

  it('throws at registration time when a bare-root path with no prefix resolves to an empty docPath', () => {
    const { defineRoute } = createRouteRegistry();
    const router = express.Router();

    expect(() => {
      defineRoute(router, {
        method: 'get',
        path: '/',
        handler: (_req, res) => res.status(200).json([]),
      });
    }).to.throw(/resolves to an empty docPath/);
  });

  it('throws at registration time when docPath has a bare wildcard segment', () => {
    const { defineRoute } = createRouteRegistry();
    const router = express.Router();

    expect(() => {
      defineRoute(router, {
        method: 'get',
        path: '/files/*',
        handler: (_req, res) => res.status(200).json({}),
      });
    }).to.throw(/wildcard docPath/);
  });

  it('does not reject a `*` that only appears inside a `{name}` placeholder', () => {
    const { defineRoute, routeRegistry } = createRouteRegistry();
    const router = express.Router();

    expect(() => {
      defineRoute(router, {
        method: 'get',
        path: '/',
        prefix: '/widgets/{na*me}',
        handler: (_req, res) => res.status(200).json({}),
      });
    }).to.not.throw();
    expect(routeRegistry.at(-1)).to.include({ docPath: '/widgets/{na*me}' });
  });

  it('infers res.locals from Provider<L> middleware', async () => {
    const { defineRoute } = createRouteRegistry();
    const router = express.Router();

    const widgetProvider: Provider<{ widget: { id: string } }> = (
      req,
      res,
      next
    ) => {
      // ParamsDictionary values are `string | string[]`; `:id` is one segment.
      res.locals.widget = { id: req.params.id as string };
      next();
    };

    defineRoute(router, {
      method: 'get',
      path: '/:id',
      prefix: '/widgets',
      middleware: [widgetProvider],
      handler: (req, res) => {
        // Compile-time check: res.locals.widget is typed from widgetProvider.
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
      prefix: '/widgets',
      request: { query: Joi.object({ q: Joi.string().required() }) },
      handler: (_req, res) => res.status(200).json([]),
    });

    const app = express();
    app.use('/widgets', router);
    app.use(validationErrorHandler);
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
      prefix: '/widgets',
      request: {
        headers: Joi.object({ 'x-tenant': Joi.string().required() }).unknown(
          true
        ),
      },
      handler: (_req, res) => res.status(200).json([]),
    });

    const app = express();
    app.use('/widgets', router);
    app.use(validationErrorHandler);
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
      prefix: '/widgets',
      request: { params: Joi.object({ id: Joi.string().uuid().required() }) },
      handler: (_req, res) => res.status(200).json([]),
    });

    const app = express();
    app.use('/widgets', router);
    app.use(validationErrorHandler);
    const request = testRequest(app);

    expect(
      (await request.get('/widgets/9f7f9b1a-3f2f-4b3f-9b1a-3f2f4b3f9b1a'))
        .statusCode
    ).to.equal(200);
    expect((await request.get('/widgets/not-a-uuid')).statusCode).to.equal(400);
  });

  it("defaults operationId to the handler's function name", () => {
    const { defineRoute, routeRegistry } = createRouteRegistry();
    const router = express.Router();
    defineRoute(router, {
      method: 'get',
      path: '/',
      prefix: '/widgets',
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
      prefix: '/widgets',
      operationId: 'listAllWidgets',
      handler: function listWidgets(_req, res) {
        res.status(200).json([]);
      },
    });

    expect(routeRegistry.at(-1)).to.include({ operationId: 'listAllWidgets' });
  });

  it('derives operationId from method and docPath for an anonymous handler', () => {
    const { defineRoute, routeRegistry } = createRouteRegistry();
    const router = express.Router();
    // Taking the function from an array keeps JS from naming it "handler".
    const [anonymousHandler] = [
      (_req: express.Request, res: express.Response) =>
        res.status(200).json([]),
    ];

    defineRoute(router, {
      method: 'get',
      path: '/',
      prefix: '/widgets/{id}',
      handler: anonymousHandler,
    });

    expect(routeRegistry.at(-1)).to.include({ operationId: 'getWidgetsId' });
  });

  it('derives operationId from method and docPath for an inline handler', () => {
    const { defineRoute, routeRegistry } = createRouteRegistry();
    const router = express.Router();

    // JS names an inline `handler: (req, res) => {}` "handler".
    defineRoute(router, {
      method: 'get',
      path: '/',
      prefix: '/widgets',
      handler: (_req, res) => res.status(200).json([]),
    });
    defineRoute(router, {
      method: 'get',
      path: '/',
      prefix: '/gadgets',
      handler: (_req, res) => res.status(200).json([]),
    });

    expect(routeRegistry.at(-2)).to.include({ operationId: 'getWidgets' });
    expect(routeRegistry.at(-1)).to.include({ operationId: 'getGadgets' });
  });

  it('derives a PascalCase operationId segment from a hyphenated path', () => {
    const { defineRoute, routeRegistry } = createRouteRegistry();
    const router = express.Router();

    defineRoute(router, {
      method: 'post',
      path: '/',
      prefix: '/gift-cards',
      handler: (_req, res) => res.status(201).json({}),
    });

    expect(routeRegistry.at(-1)).to.include({
      operationId: 'postGiftCards',
    });
  });

  it('pushes the route definition into routeRegistry', () => {
    const { defineRoute, routeRegistry } = createRouteRegistry();
    const router = express.Router();
    defineRoute(router, {
      method: 'get',
      path: '/',
      prefix: '/widgets',
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
      prefix: '/widgets',
      summary: 'List widgets',
      handler: (_req, res) => res.status(200).json([]),
    });

    const doc = buildOpenApiDocument({
      title: 'test-api',
      version: '1.0.0',
      servers: ['https://api.example.com'],
    });

    expect(doc.paths['/widgets'].get).to.include({ summary: 'List widgets' });
    expect(doc.servers).to.eql([{ url: 'https://api.example.com' }]);
  });

  it('gives each call its own registry', () => {
    const first = createRouteRegistry();
    const second = createRouteRegistry();

    first.defineRoute(express.Router(), {
      method: 'get',
      path: '/',
      prefix: '/widgets',
      handler: (_req, res) => res.status(200).json([]),
    });

    expect(first.routeRegistry).to.have.lengthOf(1);
    expect(second.routeRegistry).to.have.lengthOf(0);
  });

  it('narrows RouteDef.security to the TScheme given to createRouteRegistry', () => {
    const { defineRoute, routeRegistry } = createRouteRegistry<
      'ApiKeyAuth' | 'BearerAuth'
    >();
    const router = express.Router();

    defineRoute(router, {
      method: 'get',
      path: '/',
      prefix: '/widgets',
      // Compile-time check: 'ApiKeyAuth' is in this registry's TScheme, so it's
      // accepted; a typo would be a compile error.
      security: ['ApiKeyAuth'],
      handler: (_req, res) => res.status(200).json([]),
    });

    expect(routeRegistry.at(-1)?.security).to.eql(['ApiKeyAuth']);

    // withResponses uses the same registry's TScheme.
    defineRoute.withResponses<{ 200: { id: string } }>()(router, {
      method: 'get',
      path: '/:id',
      prefix: '/widgets',
      security: ['BearerAuth'],
      handler: (req, res) => res.status(200).json({ id: req.params.id }),
    });

    expect(routeRegistry.at(-1)?.security).to.eql(['BearerAuth']);
  });

  it('registers a route via defineRoute.withResponses, narrowing res.json to each declared status', async () => {
    const { defineRoute } = createRouteRegistry();
    const router = express.Router();

    defineRoute.withResponses<{
      200: { id: string };
      404: { message: string };
    }>()(router, {
      method: 'get',
      path: '/:id',
      prefix: '/widgets',
      handler: (req, res) => {
        if (req.params.id === 'missing') {
          // Compile-time check: the 404 body must be { message: string }.
          res.status(404).json({ message: 'not found' });
          return;
        }
        // Compile-time check: the 200 body must be { id: string }.
        res.status(200).json({ id: req.params.id });
      },
    });

    const app = express();
    app.use('/widgets', router);
    const request = testRequest(app);

    const found = await request.get('/widgets/abc');
    expect(found.statusCode).to.equal(200);
    expect(found.body).to.eql({ id: 'abc' });

    const missing = await request.get('/widgets/missing');
    expect(missing.statusCode).to.equal(404);
    expect(missing.body).to.eql({ message: 'not found' });
  });
});
