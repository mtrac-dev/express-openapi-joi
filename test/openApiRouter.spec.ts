import express from 'express';
import Joi from 'joi';
import { expect } from 'chai';

import { createRouteRegistry } from '../src/defineRoute.ts';
import {
  applyDiscriminatorMappings,
  buildOpenApiDocument,
} from '../src/document.ts';
import { createOpenApiRouter } from '../src/openApiRouter.ts';
import { securedBy } from '../src/security.ts';
import { testRequest } from './helpers/request.ts';

describe('UNIT: createOpenApiRouter', () => {
  const app = express();
  app.use(
    '/openapi.json',
    createOpenApiRouter({
      title: 'test-api',
      version: '1.0.0',
      routeRegistry: [],
    })
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

  it('derives servers from the actual incoming request, not a fixed config value', async () => {
    const res = await request.get('/openapi.json');

    expect(res.body.servers).to.have.lengthOf(1);
    expect(res.body.servers[0].url).to.match(
      /^http:\/\/127\.0\.0\.1:\d+\/openapi\.json$/
    );
  });

  describe('when mounted under a further prefix', () => {
    const nestedApp = express();
    const outerRouter = express.Router();
    outerRouter.use(
      '/openapi.json',
      createOpenApiRouter({
        title: 'test-api',
        version: '1.0.0',
        routeRegistry: [],
      })
    );
    nestedApp.use('/v1', outerRouter);

    it("includes the full cumulative mount path in servers' url", async () => {
      const res = await testRequest(nestedApp).get('/v1/openapi.json');

      expect(res.body.servers[0].url).to.match(
        /^http:\/\/127\.0\.0\.1:\d+\/v1\/openapi\.json$/
      );
    });
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
        routeRegistry: [],
        middleware: [denyAll],
      })
    );

    it("gates the route via the caller's own middleware, same as any other endpoint", async () => {
      const res = await testRequest(gatedApp).get('/openapi.json');

      expect(res.statusCode).to.equal(401);
    });
  });

  describe('with routes registered via defineRoute', () => {
    const { defineRoute, routeRegistry } = createRouteRegistry();
    const appWithRoutes = express();

    before(() => {
      const router = express.Router();
      defineRoute(router, {
        method: 'post',
        path: '/:id',
        prefix: '/widgets',
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
        prefix: '/gadgets',
        summary: 'List gadgets',
        request: {
          query: Joi.object({ tag: Joi.string().valid('a', 'b', null) }),
        },
        handler: (_req, res) => res.status(200).json([]),
      });
      defineRoute(router, {
        method: 'get',
        path: '/:id',
        prefix: '/doodads',
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
        summary: 'List thingamajigs',
        request: { query: Joi.object({ phone: customJoi.phoneNumber() }) },
        handler: (_req, res) => res.status(200).json([]),
      });
      defineRoute(router, {
        method: 'get',
        path: '/whatsits',
        summary: 'List whatsits',
        // Not an object schema -- joi-to-json emits no `properties` key at
        // all for this, exercising queryParameters' fallback for that case.
        request: { query: Joi.string() },
        handler: (_req, res) => res.status(200).json([]),
      });
      defineRoute(router, {
        method: 'get',
        path: '/thingumbobs',
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
        summary: 'List dinguses',
        // Not an object schema -- exercises headerParameters' fallback for
        // a schema with no `properties` key, same as /whatsits for query.
        request: { headers: Joi.string() },
        handler: (_req, res) => res.status(200).json([]),
      });
      const apiKeyAuth = securedBy<express.RequestHandler>(
        (_req, _res, next) => {
          next();
        },
        'ApiKeyAuth'
      );
      defineRoute(router, {
        method: 'get',
        path: '/gizmos',
        summary: 'List gizmos, as an admin',
        tags: ['admin'],
        middleware: [apiKeyAuth],
        handler: (_req, res) => res.status(200).json([]),
      });
      defineRoute(router, {
        method: 'get',
        path: '/gizmos',
        summary: 'List gizmos',
        tags: ['gizmos'],
        security: ['public'],
        handler: (_req, res) => res.status(200).json([]),
      });
      defineRoute(router, {
        method: 'get',
        path: '/widgets',
        summary: 'List widgets',
        // 'public' registered BEFORE a real scheme -- the order gizmos
        // (above) doesn't exercise, since 'public' merging with an
        // already-real security array never collapses to just `[{}]`
        // along the way.
        security: ['public'],
        handler: (_req, res) => res.status(200).json([]),
      });
      defineRoute(router, {
        method: 'get',
        path: '/widgets',
        summary: 'List widgets, as an admin',
        middleware: [apiKeyAuth],
        handler: (_req, res) => res.status(200).json([]),
      });
      defineRoute(router, {
        method: 'get',
        path: '/thingamabobs',
        summary: 'List thingamabobs, as an admin',
        middleware: [apiKeyAuth],
        // Documents a 403 not repeated by the registration below --
        // should still show up in the merged operation, not just the
        // 200 the last-registered one documents.
        responses: {
          200: { description: 'OK' },
          403: { description: 'Not an admin' },
        },
        handler: (_req, res) => res.status(200).json([]),
      });
      defineRoute(router, {
        method: 'get',
        path: '/thingamabobs',
        summary: 'List thingamabobs',
        security: ['public'],
        handler: (_req, res) => res.status(200).json([]),
      });
      defineRoute(router, {
        method: 'post',
        path: '/gearboxes',
        summary: 'Create a gearbox, as an admin',
        request: { body: Joi.object({ ratio: Joi.number().required() }) },
        handler: (_req, res) => res.status(201).json({}),
      });
      defineRoute(router, {
        method: 'post',
        path: '/gearboxes',
        summary: 'Create a gearbox',
        request: { body: Joi.object({ color: Joi.string().required() }) },
        handler: (_req, res) => res.status(201).json({}),
      });
      const sprocketSchema = Joi.object({ teeth: Joi.number().required() });
      defineRoute(router, {
        method: 'post',
        path: '/sprockets',
        summary: 'Create a sprocket, as an admin',
        request: { body: sprocketSchema },
        handler: (_req, res) => res.status(201).json({}),
      });
      defineRoute(router, {
        method: 'post',
        path: '/sprockets',
        summary: 'Create a sprocket',
        request: { body: sprocketSchema },
        handler: (_req, res) => res.status(201).json({}),
      });
      defineRoute(router, {
        method: 'post',
        path: '/cogs',
        summary: 'Create a cog, as an admin',
        // Same shape as the /cogs registration below, but with its fields
        // declared in the opposite order -- two independently-constructed
        // schemas that joi-to-json can emit with differently-ordered keys
        // even though they describe the same shape.
        request: {
          body: Joi.object({
            teeth: Joi.number().required(),
            ratio: Joi.number().required(),
          }),
        },
        handler: (_req, res) => res.status(201).json({}),
      });
      defineRoute(router, {
        method: 'post',
        path: '/cogs',
        summary: 'Create a cog',
        request: {
          body: Joi.object({
            ratio: Joi.number().required(),
            teeth: Joi.number().required(),
          }),
        },
        handler: (_req, res) => res.status(201).json({}),
      });
      defineRoute(router, {
        method: 'get',
        path: '/knobs/:id',
        summary: 'Get a knob, as an admin',
        request: { params: Joi.object({ id: Joi.string().uuid().required() }) },
        handler: (_req, res) => res.status(200).json({}),
      });
      defineRoute(router, {
        method: 'get',
        path: '/knobs/:id',
        summary: 'Get a knob',
        // Same param, same location, validated differently -- should
        // document both, not silently keep only the first-seen schema.
        request: { params: Joi.object({ id: Joi.number().required() }) },
        handler: (_req, res) => res.status(200).json({}),
      });
      defineRoute(router, {
        method: 'get',
        path: '/doohickeys',
        summary: 'List doohickeys',
        request: {
          headers: Joi.object({ 'x-tenant': Joi.string() }).unknown(true),
        },
        handler: (_req, res) => res.status(200).json([]),
      });
      defineRoute(router, {
        method: 'get',
        path: '/doohickeys',
        // No summary on this registration -- shouldn't erase the one above.
        request: {
          headers: Joi.object({ 'x-tenant': Joi.string().required() }).unknown(
            true
          ),
        },
        handler: (_req, res) => res.status(200).json([]),
      });

      appWithRoutes.use(
        '/openapi.json',
        createOpenApiRouter({
          title: 'test-api',
          version: '1.0.0',
          routeRegistry,
          securitySchemes: {
            ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' },
          },
        })
      );
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

    it('merges responses across a shared docPath+method instead of overwriting', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      const { responses } = res.body.paths['/thingamabobs'].get;
      expect(responses['403']).to.eql({ description: 'Not an admin' });
      expect(responses['200']).to.eql({ description: 'OK' });
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

    it('embeds the caller-supplied securitySchemes verbatim', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      expect(res.body.components.securitySchemes).to.eql({
        ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' },
      });
    });

    it("merges a shared docPath+method's security alternatives into one array, from both securedBy-tagged middleware and explicit security", async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      expect(res.body.paths['/gizmos'].get.security).to.have.deep.members([
        { ApiKeyAuth: [] },
        {},
      ]);
    });

    it("keeps an earlier 'public' alternative when a later registration in the same docPath+method stack requires a real scheme", async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      expect(res.body.paths['/widgets'].get.security).to.have.deep.members([
        {},
        { ApiKeyAuth: [] },
      ]);
    });

    it('unions tags across a shared docPath+method instead of only keeping the last', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      expect(res.body.paths['/gizmos'].get.tags).to.have.members([
        'admin',
        'gizmos',
      ]);
    });

    it('keeps the last-registered summary as the primary one, and lists the others in description', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      const op = res.body.paths['/gizmos'].get;
      expect(op.summary).to.equal('List gizmos');
      expect(op.description).to.equal(
        'Behavior varies by caller. Also available: List gizmos, as an admin'
      );
    });

    it('wraps requestBody in oneOf when a shared docPath+method validates genuinely different schemas', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      const { schema } =
        res.body.paths['/gearboxes'].post.requestBody.content[
          'application/json'
        ];
      expect(schema.oneOf).to.have.deep.members([
        {
          type: 'object',
          properties: { ratio: { type: 'number' } },
          required: ['ratio'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { color: { type: 'string' } },
          required: ['color'],
          additionalProperties: false,
        },
      ]);
    });

    it('does not wrap requestBody in oneOf when every registration agrees on the same schema', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      const { schema } =
        res.body.paths['/sprockets'].post.requestBody.content[
          'application/json'
        ];
      expect(schema.oneOf).to.be.undefined;
      expect(schema).to.eql({
        type: 'object',
        properties: { teeth: { type: 'number' } },
        required: ['teeth'],
        additionalProperties: false,
      });
    });

    it('does not wrap requestBody in oneOf for two schemas of the same shape declared with fields in a different order', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      const { schema } =
        res.body.paths['/cogs'].post.requestBody.content['application/json'];
      expect(schema.oneOf).to.be.undefined;
    });

    it('wraps a shared parameter in oneOf when registrations validate it with different schemas', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      const idParam = res.body.paths['/knobs/{id}'].get.parameters.find(
        (p: { name: string }) => p.name === 'id'
      );
      expect(idParam.schema.oneOf).to.have.deep.members([
        { type: 'string', format: 'uuid' },
        { type: 'number' },
      ]);
    });

    it('keeps an earlier summary when a later registration sharing the docPath+method gives none', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      expect(res.body.paths['/doohickeys'].get.summary).to.equal(
        'List doohickeys'
      );
    });

    it('is required in the merged parameters if any registration sharing the docPath+method requires it', async () => {
      const res = await testRequest(appWithRoutes).get('/openapi.json');

      const siteParam = res.body.paths['/doohickeys'].get.parameters.find(
        (p: { name: string }) => p.name === 'x-tenant'
      );
      expect(siteParam).to.include({ required: true });
    });
  });

  describe('with a Joi schema using .id()', () => {
    it('produces a $ref requestBody schema and populates components.schemas', async () => {
      const { defineRoute, routeRegistry } = createRouteRegistry();
      const router = express.Router();
      const schema = Joi.object({ name: Joi.string().required() }).id('Widget');
      defineRoute(router, {
        method: 'post',
        path: '/',
        prefix: '/id-test-widgets',
        summary: 'Create a widget',
        request: { body: schema },
        handler: (_req, res) => res.status(201).json({}),
      });
      const app = express();
      app.use(
        '/openapi.json',
        createOpenApiRouter({ title: 't', version: '1', routeRegistry })
      );

      const res = await testRequest(app).get('/openapi.json');

      expect(
        res.body.paths['/id-test-widgets'].post.requestBody.content[
          'application/json'
        ].schema
      ).to.eql({ $ref: '#/components/schemas/Widget' });
      expect(res.body.components.schemas.Widget).to.eql({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      });
    });

    it("dereferences a header schema whose whole wrapper is id'd back to its own properties", async () => {
      const { defineRoute, routeRegistry } = createRouteRegistry();
      const router = express.Router();
      const headers = Joi.object({
        'x-thing': Joi.string().required(),
      }).id('ThingHeader');
      defineRoute(router, {
        method: 'get',
        path: '/',
        prefix: '/id-test-thing',
        summary: 'Get a thing',
        request: { headers },
        handler: (_req, res) => res.status(200).json({}),
      });
      const app = express();
      app.use(
        '/openapi.json',
        createOpenApiRouter({ title: 't', version: '1', routeRegistry })
      );

      const res = await testRequest(app).get('/openapi.json');
      const param = res.body.paths['/id-test-thing'].get.parameters.find(
        (p: { name: string }) => p.name === 'x-thing'
      );

      expect(param).to.include({ required: true });
      expect(res.body.components.schemas.ThingHeader).to.exist;
    });

    it('throws when two different Joi schemas use the same id', () => {
      const { defineRoute, buildOpenApiDocument } = createRouteRegistry();
      const router = express.Router();
      defineRoute(router, {
        method: 'post',
        path: '/',
        prefix: '/id-test-collision-a',
        summary: 'A',
        request: { body: Joi.object({ a: Joi.string() }).id('Collision') },
        handler: (_req, res) => res.status(201).json({}),
      });
      defineRoute(router, {
        method: 'post',
        path: '/',
        prefix: '/id-test-collision-b',
        summary: 'B',
        request: { body: Joi.object({ b: Joi.number() }).id('Collision') },
        handler: (_req, res) => res.status(201).json({}),
      });

      expect(() => buildOpenApiDocument({ title: 't', version: '1' })).to.throw(
        /'Collision'.*different shapes/
      );
    });

    it('does not throw for two equally-shaped .id() schemas whose fields are declared in a different order', () => {
      const { defineRoute, buildOpenApiDocument } = createRouteRegistry();
      const router = express.Router();
      defineRoute(router, {
        method: 'post',
        path: '/',
        prefix: '/id-test-reordered-a',
        summary: 'A',
        request: {
          body: Joi.object({
            teeth: Joi.number().required(),
            ratio: Joi.number().required(),
          }).id('Reordered'),
        },
        handler: (_req, res) => res.status(201).json({}),
      });
      defineRoute(router, {
        method: 'post',
        path: '/',
        prefix: '/id-test-reordered-b',
        summary: 'B',
        request: {
          body: Joi.object({
            ratio: Joi.number().required(),
            teeth: Joi.number().required(),
          }).id('Reordered'),
        },
        handler: (_req, res) => res.status(201).json({}),
      });

      expect(() =>
        buildOpenApiDocument({ title: 't', version: '1' })
      ).not.to.throw();
    });
  });

  describe('RouteDef.private', () => {
    it('is absent from a document built from a private-filtered registry, but present in the full one', () => {
      const { defineRoute, routeRegistry } = createRouteRegistry();
      defineRoute(express.Router(), {
        method: 'get',
        path: '/',
        prefix: '/internal-only',
        private: true,
        summary: 'Internal only',
        handler: (_req, res) => res.status(200).json({}),
      });

      const publicDoc = buildOpenApiDocument(
        routeRegistry.filter((route) => !route.private),
        { title: 't', version: '1' }
      );
      expect(publicDoc.paths['/internal-only']).to.be.undefined;

      const fullDoc = buildOpenApiDocument(routeRegistry, {
        title: 't',
        version: '1',
      });
      expect(fullDoc.paths['/internal-only']).to.exist;
    });

    it('narrows a shared docPath+method down to just its own non-private branch when filtered', () => {
      const { defineRoute, routeRegistry } = createRouteRegistry();
      const router = express.Router();
      defineRoute(router, {
        method: 'get',
        path: '/',
        prefix: '/mixed',
        private: true,
        summary: 'Internal branch',
        security: ['InternalAuth'],
        handler: (_req, res) => res.status(200).json({}),
      });
      defineRoute(router, {
        method: 'get',
        path: '/',
        prefix: '/mixed',
        summary: 'Public branch',
        security: ['public'],
        handler: (_req, res) => res.status(200).json({}),
      });

      const publicDoc = buildOpenApiDocument(
        routeRegistry.filter((route) => !route.private),
        { title: 't', version: '1' }
      );
      const op = publicDoc.paths['/mixed'].get;

      expect(op?.summary).to.equal('Public branch');
      // Merged down to only `[{}]` ("public") once the InternalAuth branch
      // is filtered out -- omitted entirely by the same isOnlyPublic
      // optimization a route with no private branch at all already gets.
      expect(op?.security).to.be.undefined;
    });
  });

  describe('commonResponses', () => {
    const commonResponses = {
      404: { description: 'common not found' },
      500: { description: 'common server error' },
    };

    it('merges into a route with no responses of its own, without fabricating a success status', () => {
      const { defineRoute, buildOpenApiDocument } = createRouteRegistry();
      const router = express.Router();
      defineRoute(router, {
        method: 'get',
        path: '/',
        prefix: '/common-responses-a',
        summary: 'a',
        handler: (_req, res) => res.status(200).json({}),
      });

      const doc = buildOpenApiDocument({
        title: 't',
        version: '1',
        commonResponses,
      });
      const responses = doc.paths['/common-responses-a'].get?.responses;

      // No 200 -- a route that never says what it returns shouldn't have
      // one invented for it (that's exactly the assumption that broke a
      // real generated client the one time a route's real success status
      // wasn't 200: a fabricated, schema-less 200 sat next to the real,
      // schema'd status, and the client generator picked the fabricated
      // one).
      expect(responses?.['200']).to.be.undefined;

      expect(responses?.['404']).to.eql({ description: 'common not found' });
      expect(responses?.['500']).to.eql({
        description: 'common server error',
      });
    });

    it("lets the route's own response win on a status-code collision", () => {
      const { defineRoute, buildOpenApiDocument } = createRouteRegistry();
      const router = express.Router();
      defineRoute(router, {
        method: 'get',
        path: '/',
        prefix: '/common-responses-b',
        summary: 'b',
        responses: {
          404: { description: 'this specific thing was not found' },
        },
        handler: (_req, res) => res.status(200).json({}),
      });

      const doc = buildOpenApiDocument({
        title: 't',
        version: '1',
        commonResponses,
      });
      const responses = doc.paths['/common-responses-b'].get?.responses;

      expect(responses?.['404']).to.eql({
        description: 'this specific thing was not found',
      });
      expect(responses?.['500']).to.eql({
        description: 'common server error',
      });
    });
  });
});

describe('UNIT: applyDiscriminatorMappings', () => {
  it("derives a discriminator mapping from each oneOf variant's own `const` property", () => {
    const componentSchemas = {
      Shape: {
        discriminator: { propertyName: 'kind' },
        oneOf: [
          { $ref: '#/components/schemas/Circle' },
          { $ref: '#/components/schemas/Square' },
        ],
      },
      Circle: {
        type: 'object',
        properties: { kind: { const: 'circle' }, radius: { type: 'number' } },
      },
      Square: {
        type: 'object',
        properties: { kind: { const: 'square' }, side: { type: 'number' } },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- hand-built fixture data, not a real generated schema
    } as Record<string, any>;

    applyDiscriminatorMappings(componentSchemas);

    expect(componentSchemas.Shape.discriminator.mapping).to.eql({
      circle: '#/components/schemas/Circle',
      square: '#/components/schemas/Square',
    });
  });

  it("derives a discriminator mapping from a variant's own single-value `enum` property", () => {
    const componentSchemas = {
      Shape: {
        discriminator: { propertyName: 'kind' },
        oneOf: [{ $ref: '#/components/schemas/Circle' }],
      },
      Circle: {
        type: 'object',
        properties: { kind: { enum: ['circle'] } },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- hand-built fixture data, not a real generated schema
    } as Record<string, any>;

    applyDiscriminatorMappings(componentSchemas);

    expect(componentSchemas.Shape.discriminator.mapping).to.eql({
      circle: '#/components/schemas/Circle',
    });
  });

  it('leaves a schema with no discriminator, or an already-mapped one, untouched', () => {
    const componentSchemas = {
      PlainObject: { type: 'object', properties: {} },
      AlreadyMapped: {
        discriminator: {
          propertyName: 'kind',
          mapping: { circle: '#/components/schemas/Circle' },
        },
        oneOf: [{ $ref: '#/components/schemas/Circle' }],
      },
      NoOneOf: { discriminator: { propertyName: 'kind' } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- hand-built fixture data, not a real generated schema
    } as Record<string, any>;
    const before = JSON.parse(JSON.stringify(componentSchemas)) as unknown;

    applyDiscriminatorMappings(componentSchemas);

    expect(componentSchemas).to.eql(before);
  });

  it("throws when a oneOf entry isn't a $ref", () => {
    const componentSchemas = {
      Shape: {
        discriminator: { propertyName: 'kind' },
        oneOf: [{ type: 'object', properties: { kind: { const: 'circle' } } }],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- hand-built fixture data, not a real generated schema
    } as Record<string, any>;

    expect(() => {
      applyDiscriminatorMappings(componentSchemas);
    }).to.throw(/has a non-\$ref oneOf entry/);
  });

  it("throws when a variant doesn't narrow its own discriminator property to a single string literal", () => {
    const componentSchemas = {
      Shape: {
        discriminator: { propertyName: 'kind' },
        oneOf: [{ $ref: '#/components/schemas/Circle' }],
      },
      Circle: { type: 'object', properties: { kind: { type: 'string' } } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- hand-built fixture data, not a real generated schema
    } as Record<string, any>;

    expect(() => {
      applyDiscriminatorMappings(componentSchemas);
    }).to.throw(
      /doesn't narrow its own 'kind' property to a single string literal/
    );
  });
});
