import express from 'express';

import { buildOpenApiDocument } from './document.ts';
import type { AnyRouteDef } from './defineRoute.ts';

/**
 * Serves a generated OpenAPI document at `GET /` -- mount this router
 * wherever the document should be exposed (e.g.
 * `app.use('/openapi.json', createOpenApiRouter({ title, version,
 * routeRegistry }))`). The document is built once and cached, not rebuilt
 * per request.
 */
export function createOpenApiRouter({
  title,
  version,
  routeRegistry,
  middleware = [],
}: {
  title: string;
  version: string;
  /** The registry returned by createRouteRegistry() (see ./defineRoute.ts). */
  routeRegistry: readonly AnyRouteDef[];
  /**
   * Gates this route however the caller's own app gates any other
   * internal endpoint (an API key check, an auth middleware, etc.) --
   * this library doesn't assume anything about a caller's auth strategy,
   * so there's no default here beyond leaving the route open.
   */
  middleware?: express.RequestHandler[];
}) {
  const router = express.Router();

  let cachedDocument: ReturnType<typeof buildOpenApiDocument> | undefined;

  router.get('/', ...middleware, (_req, res) => {
    cachedDocument ??= buildOpenApiDocument(routeRegistry, { title, version });
    res.set('Cache-Control', 'public, max-age=3600');
    res.status(200).json(cachedDocument);
  });

  return router;
}
