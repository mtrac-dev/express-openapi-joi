import express from 'express';

import { defineRoute } from '../../../src/index.ts';
// Deliberately no `.ts` extension -- this whole directory is excluded from
// the main tsconfig.json's typecheck (NodeNext forbids exactly this) and
// resolved instead via its own sibling tsconfig.json (classic Node
// resolution), the way a real CJS consumer's own router files are
// typically written. Exercises resolveNamedImportConsts' "no explicit .ts
// extension" branch -- appending one, rather than the double-extension bug
// unconditional appending would produce for an already-.ts-suffixed
// specifier (see ../importedPathRouter.ts for that case).
import { WIDGET_ID } from './paths';
// A real, validly-resolving directory-index import under classic Node
// resolution (`./otherConsts` -> `./otherConsts/index.ts`) --
// resolveNamedImportConsts only ever guesses a same-directory
// `./otherConsts.ts` file, not real module resolution, so this
// deliberately fails to resolve into constMap (exercising its own
// "importedSourceFile not found" branch) despite being a perfectly valid
// import as far as the real TypeScript compiler (and any real consumer
// reading this file) is concerned. Not used for any path/prefix value --
// there'd be nothing to resolve it to even if it were.
import { UNUSED_ID } from './otherConsts';

export interface Doohickey {
  id: string;
}

const router = express.Router();

defineRoute.withResponses<{ 200: Doohickey }>()(router, {
  method: 'get',
  path: `/:${WIDGET_ID}`,
  prefix: '/doohickeys',
  summary: 'Get a doohickey',
  responses: { 200: { description: 'The doohickey' } },
  handler: (req, res) => {
    res.status(200).json({ id: req.params[WIDGET_ID] });
  },
});

export default router;
