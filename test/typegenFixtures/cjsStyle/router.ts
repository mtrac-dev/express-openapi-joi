import express from 'express';

import { defineRoute } from '../../../src/index.ts';
// No `.ts` extension, as in a CommonJS app using classic resolution. This
// directory has its own tsconfig.json, since NodeNext rejects it. Tests that
// resolveNamedImportConsts appends `.ts`; importedPathRouter.ts covers a
// specifier that already has it.
import { WIDGET_ID } from './paths';
// A directory import, `./otherConsts` for `./otherConsts/index.ts`.
// resolveNamedImportConsts only looks for `./otherConsts.ts`, so this tests
// the branch where the imported file isn't found.
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
