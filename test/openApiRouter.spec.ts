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
        handler: (_req, res) => res.status(200).json([]),
      });
      defineRoute(router, {
        method: 'get',
        path: '/:id',
        docPath: '/doodads/{id}',
        summary: 'Get a doodad',
        handler: (_req, res) => res.status(200).json({}),
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

    it('omits parameters entirely for a docPath with no path params', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      const gadgetPath = res.body.paths['/gadgets'];
      expect(gadgetPath.get).to.not.have.property('parameters');
    });

    it('falls back to a bare string schema for a path param with no request.params schema', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      const doodadPath = res.body.paths['/doodads/{id}'];
      expect(doodadPath.get.parameters).to.have.deep.members([
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      ]);
    });
  });
});
