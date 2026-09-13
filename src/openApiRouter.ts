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
  securitySchemes,
  middleware = [],
}: {
  title: string;
  version: string;
  /** The registry returned by createRouteRegistry() (see ./defineRoute.ts). */
  routeRegistry: readonly AnyRouteDef[];
  /** Embedded verbatim into the document's components.securitySchemes. */
  securitySchemes?: Record<string, unknown>;
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

  router.get('/', ...middleware, (req, res) => {
    cachedDocument ??= buildOpenApiDocument(routeRegistry, {
      title,
      version,
      securitySchemes,
    });

    // servers isn't part of the cached document: this library doesn't
    // assume anything about a caller's own public base URL. req.baseUrl
    // is the full mount path this router was reached through (cumulative
    // across any nesting), since this route is registered at this
    // router's own root ('/') -- so it's already exactly the base path
    // this document is served under, with nothing of this router's own
    // to strip back off. The Host header is mandatory on every real
    // HTTP/1.1 request, so the `?? ''` fallback is unreachable in
    // practice -- @types/express just can't express that req.get('host')
    // is never actually undefined here.
    /* c8 ignore next */
    const host = req.get('host') ?? '';
    const servers = [{ url: `${req.protocol}://${host}${req.baseUrl}` }];

    res.set('Cache-Control', 'public, max-age=3600');
    res.status(200).json({ ...cachedDocument, servers });
  });

  return router;
}
