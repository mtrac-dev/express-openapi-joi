import express from 'express';
// A named import from a non-relative package -- resolveNamedImportConsts'
// "moduleSpecifier doesn't start with '.'" early-return branch. Genuinely
// used below (not just imported for this), so there's nothing here for
// lint to flag as unused.
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

// `path` references GADGET_ID -- a named import from a relative sibling
// file, itself declared with `as const` -- exercising both
// resolveNamedImportConsts' successful-resolution path and
// resolveStringExpression's AsExpression-unwrapping branch.
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
