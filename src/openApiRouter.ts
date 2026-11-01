import express from 'express';
import type { SecuritySchemeObject } from 'openapi3-ts/oas31';

import { buildOpenApiDocument } from './document.ts';
import type { AnyRouteDef } from './defineRoute.ts';

/**
 * Create a router that serves the OpenAPI document as JSON at its mount path.
 *
 * @remarks
 * The document is built on the first request, then cached.
 *
 * @param options - The document's title and version, and the routes to
 *   document.
 * @returns An Express router, to mount with `app.use`.
 *
 * @example
 * ```ts
 * app.use(
 *   '/openapi.json',
 *   createOpenApiRouter({ title: 'Widgets API', version: '1.0.0', routeRegistry })
 * );
 * ```
 */
export function createOpenApiRouter({
  title,
  version,
  routeRegistry,
  servers,
  securitySchemes,
  middleware = [],
}: {
  /** The document's `info.title`. */
  title: string;
  /** The document's `info.version`: the API's version. */
  version: string;
  /** The routes to document: `routeRegistry`, or one from `createRouteRegistry()`. */
  routeRegistry: readonly AnyRouteDef[];
  /**
   * URLs for the document's `servers` list.
   *
   * @defaultValue The request's origin, such as `https://api.example.com`.
   */
  servers?: string[];
  /** Security schemes to add as-is to `components.securitySchemes`. */
  securitySchemes?: Record<string, SecuritySchemeObject>;
  /**
   * Middleware to run before the document is served, for example to require
   * authentication.
   *
   * @defaultValue `[]`
   */
  middleware?: express.RequestHandler[];
}) {
  const router = express.Router();

  let cachedDocument: ReturnType<typeof buildOpenApiDocument> | undefined;

  router.get('/', ...middleware, (req, res) => {
    cachedDocument ??= buildOpenApiDocument(routeRegistry, {
      title,
      version,
      servers,
      securitySchemes,
    });

    res.set('Cache-Control', 'public, max-age=3600');
    if (servers) {
      res.status(200).json(cachedDocument);
      return;
    }

    // Default to the request's origin. Document paths include each route's
    // prefix, so they're relative to the app root, not this router's mount
    // path. Every HTTP/1.1 request has a Host header, so the `''` fallback is
    // never used.
    /* c8 ignore next */
    const host = req.get('host') ?? '';
    res.status(200).json({
      ...cachedDocument,
      servers: [{ url: `${req.protocol}://${host}` }],
    });
  });

  return router;
}
