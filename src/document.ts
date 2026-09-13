export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, unknown>;
}

/**
 * Bare-minimum valid OpenAPI document -- no paths yet. This exists to
 * validate hosting a generated spec (live, from the running app) before
 * any real routes are described. Real route coverage lands incrementally,
 * via defineRoute (see ./defineRoute.ts).
 */
export function buildOpenApiDocument({
  title,
  version,
}: {
  title: string;
  version: string;
}): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: { title, version },
    paths: {},
  };
}
