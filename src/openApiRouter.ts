import express from 'express';

import { buildOpenApiDocument } from './document.ts';

/**
 * Serves a generated OpenAPI document at `GET /` -- mount this router
 * wherever the document should be exposed (e.g.
 * `app.use('/openapi.json', createOpenApiRouter({ title, version }))`).
 * The document is built once and cached, not rebuilt per request.
 */
export function createOpenApiRouter({
  title,
  version,
}: {
  title: string;
  version: string;
}) {
  const router = express.Router();

  let cachedDocument: ReturnType<typeof buildOpenApiDocument> | undefined;

  router.get('/', (_req, res) => {
    cachedDocument ??= buildOpenApiDocument({ title, version });
    res.set('Cache-Control', 'public, max-age=3600');
    res.status(200).json(cachedDocument);
  });

  return router;
}
