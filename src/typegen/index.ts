// A separate subpath (`@mtrac/express-openapi-joi/typegen`), not
// re-exported from the package's own main entry point: this whole
// directory depends on ts-json-schema-generator and the TypeScript
// compiler API, real weight a consumer using only defineRoute/
// buildOpenApiDocument shouldn't have to pull in.
export {
  applyGeneratedResponseSchemas,
  fileLooksLikeItUsesWithResponses,
} from './applyGeneratedResponseSchemas.ts';
export {
  createFileProgram,
  generateResponseSchema,
  type GeneratedSchema,
} from './schemaGenerator.ts';
