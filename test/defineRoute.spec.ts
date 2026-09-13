import express from 'express';
import Joi from 'joi';
import { expect } from 'chai';

import { defineRoute, routeRegistry } from '../src/defineRoute.ts';
import { testRequest } from './helpers/request.ts';

describe('UNIT: defineRoute', () => {
  beforeEach(() => {
    routeRegistry.length = 0;
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

  it('accepts an explicit Params override for mergeParams-derived params not visible in the router-relative path', async () => {
    const router = express.Router({ mergeParams: true });

    defineRoute<'/', { cartId: string; itemId: string }>(router, {
      method: 'delete',
      path: '/',
      docPath: '/carts/{cartId}/items/{itemId}',
      handler: (req, res) => {
        // Compile-time check: req.params.cartId/itemId type-check even
        // though '/' alone has no params to extract.
        res
          .status(200)
          .json({ cartId: req.params.cartId, itemId: req.params.itemId });
      },
    });

    const app = express();
    app.use('/carts/:cartId/items/:itemId', router);

    const res = await testRequest(app).delete('/carts/p1/items/i1');

    expect(res.statusCode).to.equal(200);
    expect(res.body).to.eql({ cartId: 'p1', itemId: 'i1' });
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

    expect(routeRegistry).to.have.lengthOf(1);
    expect(routeRegistry[0]).to.include({
      method: 'get',
      docPath: '/widgets',
      summary: 'List widgets',
    });
  });
});
