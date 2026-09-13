import express from 'express';
import Joi from 'joi';
import { expect } from 'chai';

import { defineRoute, routeRegistry } from '../src/defineRoute.ts';
import { createOpenApiRouter } from '../src/openApiRouter.ts';
import { testRequest } from './helpers/request.ts';

describe('UNIT: createOpenApiRouter', () => {
  const app = express();
  app.use(
    '/openapi.json',
    createOpenApiRouter({ title: 'test-api', version: '1.0.0' })
  );
  const request = testRequest(app);

  it('returns 200 with a minimally valid OpenAPI document', async () => {
    const res = await request.get('/openapi.json');

    expect(res.statusCode).to.equal(200);
    expect(res.body).to.include({ openapi: '3.1.0' });
    expect(res.body.info).to.include({ title: 'test-api', version: '1.0.0' });
    expect(res.body.paths).to.eql({});
  });

  it('sets a Cache-Control header so repeat hits can be absorbed upstream', async () => {
    const res = await request.get('/openapi.json');

    expect(res.headers['cache-control']).to.equal('public, max-age=3600');
  });

  describe('with gating middleware', () => {
    const gatedApp = express();
    const denyAll: express.RequestHandler = (_req, res) => {
      res.status(401).json({});
    };
    gatedApp.use(
      '/openapi.json',
      createOpenApiRouter({
        title: 'test-api',
        version: '1.0.0',
        middleware: [denyAll],
      })
    );

    it("gates the route via the caller's own middleware, same as any other endpoint", async () => {
      const res = await testRequest(gatedApp).get('/openapi.json');

      expect(res.statusCode).to.equal(401);
    });
  });

  describe('with routes registered via defineRoute', () => {
    let initialLength: number;

    // A dedicated app/router, not the outer describe's shared one -- that
    // one already cached an (empty) document from the tests above, and
    // createOpenApiRouter never rebuilds once cached.
    const appWithRoutes = express();

    before(() => {
      initialLength = routeRegistry.length;

      const router = express.Router();
      defineRoute(router, {
        method: 'post',
        path: '/:id',
        docPath: '/widgets/{id}',
        request: {
          body: Joi.object({ name: Joi.string().required() }),
          params: Joi.object({ id: Joi.string().uuid().required() }),
        },
        summary: 'Create a widget',
        handler: (_req, res) => res.status(201).json({}),
      });
      defineRoute(router, {
        method: 'get',
        path: '/',
        docPath: '/gadgets',
        summary: 'List gadgets',
        request: {
          query: Joi.object({ tag: Joi.string().valid('a', 'b', null) }),
        },
        handler: (_req, res) => res.status(200).json([]),
      });
      defineRoute(router, {
        method: 'get',
        path: '/:id',
        docPath: '/doodads/{id}',
        summary: 'Get a doodad',
        request: {
          headers: Joi.object({ 'x-tenant': Joi.string().required() }).unknown(
            true
          ),
        },
        responses: {
          200: { description: 'The doodad', schema: { type: 'object' } },
        },
        handler: (_req, res) => res.status(200).json({}),
      });
      const customJoi = Joi.extend((joi) => ({
        type: 'phoneNumber',
        base: joi.string(),
      }));
      defineRoute(router, {
        method: 'get',
        path: '/thingamajigs',
        docPath: '/thingamajigs',
        summary: 'List thingamajigs',
        request: { query: Joi.object({ phone: customJoi.phoneNumber() }) },
        handler: (_req, res) => res.status(200).json([]),
      });
      defineRoute(router, {
        method: 'get',
        path: '/whatsits',
        docPath: '/whatsits',
        summary: 'List whatsits',
        // Not an object schema -- joi-to-json emits no `properties` key at
        // all for this, exercising queryParameters' fallback for that case.
        request: { query: Joi.string() },
        handler: (_req, res) => res.status(200).json([]),
      });
      defineRoute(router, {
        method: 'get',
        path: '/thingumbobs',
        docPath: '/thingumbobs',
        summary: 'List thingumbobs',
        // Nothing required -- joi-to-json emits no `required` key at all,
        // exercising headerParameters' fallback for that case.
        request: {
          headers: Joi.object({ 'x-tenant': Joi.string() }).unknown(true),
        },
        handler: (_req, res) => res.status(200).json([]),
      });
      defineRoute(router, {
        method: 'get',
        path: '/dinguses',
        docPath: '/dinguses',
        summary: 'List dinguses',
        // Not an object schema -- exercises headerParameters' fallback for
        // a schema with no `properties` key, same as /whatsits for query.
        request: { headers: Joi.string() },
        handler: (_req, res) => res.status(200).json([]),
      });

      appWithRoutes.use(
        '/openapi.json',
        createOpenApiRouter({ title: 'test-api', version: '1.0.0' })
      );
    });

    after(() => {
      routeRegistry.length = initialLength;
    });

    it('describes a path parameter using its own Joi schema, not a bare string fallback', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      const widgetPath = res.body.paths['/widgets/{id}'];
      expect(widgetPath).to.have.all.keys('post');
      expect(widgetPath.post).to.include({ summary: 'Create a widget' });
      expect(widgetPath.post.parameters).to.have.deep.members([
        {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', format: 'uuid' },
        },
      ]);
      expect(widgetPath.post.requestBody).to.exist;
    });

    it('emits a query parameter from request.query, including a nullable enum', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      const gadgetPath = res.body.paths['/gadgets'];
      expect(gadgetPath.get.parameters).to.have.deep.members([
        {
          name: 'tag',
          in: 'query',
          required: false,
          schema: { type: ['string', 'null'], enum: ['a', 'b', null] },
        },
      ]);
    });

    it('falls back to a bare string schema for a path param with no request.params schema, and emits a header parameter from request.headers', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      const doodadPath = res.body.paths['/doodads/{id}'];
      expect(doodadPath.get.parameters).to.have.deep.members([
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        {
          name: 'x-tenant',
          in: 'header',
          required: true,
          schema: { type: 'string' },
        },
      ]);
    });

    it('carries a response schema through to the document when one is given', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      const doodadPath = res.body.paths['/doodads/{id}'];
      expect(doodadPath.get.responses['200']).to.eql({
        description: 'The doodad',
        content: { 'application/json': { schema: { type: 'object' } } },
      });
    });

    it("normalizes a custom Joi extension's type to a real JSON Schema primitive", async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      const thingamajigPath = res.body.paths['/thingamajigs'];
      expect(thingamajigPath.get.parameters).to.have.deep.members([
        {
          name: 'phone',
          in: 'query',
          required: false,
          schema: { type: 'string' },
        },
      ]);
    });

    it('emits no query parameters for a non-object query schema', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      const whatsitPath = res.body.paths['/whatsits'];
      expect(whatsitPath.get.parameters).to.eql([]);
    });

    it('emits no header parameters for a non-object headers schema', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      const dingusPath = res.body.paths['/dinguses'];
      expect(dingusPath.get.parameters).to.eql([]);
    });

    it('treats every header as optional when no field in the schema is required', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      const thingumbobPath = res.body.paths['/thingumbobs'];
      expect(thingumbobPath.get.parameters).to.have.deep.members([
        {
          name: 'x-tenant',
          in: 'header',
          required: false,
          schema: { type: 'string' },
        },
      ]);
    });
  });
});
