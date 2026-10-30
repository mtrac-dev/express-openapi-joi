import express from 'express';
// A named import from a package: resolveNamedImportConsts ignores
// non-relative specifiers.
import type { Request } from 'express';

import { defineRoute } from '../../src/index.ts';
import { GADGET_ID } from './importedPathConsts.ts';

export interface Gadget {
  id: string;
}

const router = express.Router();

function extractGadgetId(req: Request): string {
  return req.params[GADGET_ID] as string;
}

// `path` uses GADGET_ID, an `as const` constant imported from a relative
// file.
defineRoute.withResponses<{ 200: Gadget }>()(router, {
  method: 'get',
  path: `/:${GADGET_ID}`,
  prefix: '/gadgets',
  summary: 'Get a gadget',
  responses: { 200: { description: 'The gadget' } },
  handler: (req, res) => {
    res.status(200).json({ id: extractGadgetId(req) });
  },
});

export default router;
