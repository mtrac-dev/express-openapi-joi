import express from 'express';

import { defineRoute } from '../../src/index.ts';

export interface Found {
  ok: true;
}

export interface NotFoundBody {
  ok: false;
}

const router = express.Router();

// Declares 404 in Responses but never documents it in `responses` --
// applyGeneratedResponseSchemas should throw rather than invent a
// description for it.
defineRoute.withResponses<{ 200: Found; 404: NotFoundBody }>()(router, {
  method: 'get',
  path: '/',
  prefix: '/missing-description',
  summary: 'Declares a status in Responses with no matching responses entry',
  responses: { 200: { description: 'OK' } },
  handler: (_req, res) => {
    res.status(200).json({ ok: true });
  },
});

export default router;
