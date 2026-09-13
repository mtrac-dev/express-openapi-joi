import express from 'express';
import { expect } from 'chai';

import { createOpenApiRouter } from '../src/openApiRouter.ts';
import { testRequest } from './helpers/request.ts';

describe('UNIT: createOpenApiRouter', () => {
  const app = express();
  app.use(
    '/openapi.json',
    createOpenApiRouter({ title: 'test-api', version: '1.0.0' })
  );
  const request = testRequest(app);

  it('returns 200 with a minimally valid OpenAPI document', async () => {
    const res = await request.get('/openapi.json');

    expect(res.statusCode).to.equal(200);
    expect(res.body).to.include({ openapi: '3.1.0' });
    expect(res.body.info).to.include({ title: 'test-api', version: '1.0.0' });
    expect(res.body.paths).to.eql({});
  });

  it('sets a Cache-Control header so repeat hits can be absorbed upstream', async () => {
    const res = await request.get('/openapi.json');

    expect(res.headers['cache-control']).to.equal('public, max-age=3600');
  });
});
