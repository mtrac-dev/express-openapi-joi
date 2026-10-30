// A separate entry point, so apps that don't generate response schemas
// don't load ts-json-schema-generator and the TypeScript compiler.
export {
  applyGeneratedResponseSchemas,
  fileLooksLikeItUsesWithResponses,
} from './applyGeneratedResponseSchemas.ts';
export {
  createFileProgram,
  generateResponseSchema,
  type GeneratedSchema,
} from './schemaGenerator.ts';
