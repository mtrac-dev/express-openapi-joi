import express from 'express';
import Joi from 'joi';
import { expect } from 'chai';

import { defineRoute, routeRegistry } from '../src/defineRoute.ts';
import type { Provider } from '../src/provider.ts';
import { testRequest } from './helpers/request.ts';

describe('UNIT: defineRoute', () => {
  // routeRegistry is a single shared, module-level array -- other spec
  // files (e.g. openApiRouter.spec.ts) read it through buildOpenApiDocument.
  // Truncate back to the length recorded before each test, not to zero --
  // wiping it outright would leak into whichever spec file runs next.
  let initialLength: number;
  beforeEach(() => {
    initialLength = routeRegistry.length;
  });
  afterEach(() => {
    routeRegistry.length = initialLength;
  });

  it('infers path params from a string-literal path, with no explicit Params argument', async () => {
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

  it('mergeParams-derived params not visible in the router-relative path need a local cast, not a generic argument', async () => {
    const router = express.Router({ mergeParams: true });

    defineRoute(router, {
      method: 'delete',
      path: '/',
      docPath: '/carts/{cartId}/items/{itemId}',
      handler: (req, res) => {
        // '/' alone has nothing for ExtractRouteParams to find -- cartId/itemId
        // come from the parent mount below, so they need a local cast here.
        const { cartId, itemId } = req.params as unknown as {
          cartId: string;
          itemId: string;
        };
        res.status(200).json({ cartId, itemId });
      },
    });

    const app = express();
    app.use('/carts/:cartId/items/:itemId', router);

    const res = await testRequest(app).delete('/carts/p1/items/i1');

    expect(res.statusCode).to.equal(200);
    expect(res.body).to.eql({ cartId: 'p1', itemId: 'i1' });
  });

  it('infers Locals from Provider<L> middleware, the same merging a provideAll()-style combinator does for the type system', async () => {
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

  it('pushes the route definition into routeRegistry for later OpenAPI-document generation', () => {
    const router = express.Router();
    defineRoute(router, {
      method: 'get',
      path: '/',
      docPath: '/widgets',
      summary: 'List widgets',
      handler: (_req, res) => res.status(200).json([]),
    });

    expect(routeRegistry).to.have.lengthOf(initialLength + 1);
    expect(routeRegistry.at(-1)).to.include({
      method: 'get',
      docPath: '/widgets',
      summary: 'List widgets',
    });
  });
});
