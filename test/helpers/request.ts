import supertest from 'supertest';
import type { Application } from 'express';
import type { Response, Test } from 'supertest';

// @types/supertest 7.x's Test class is thenable at runtime (`await
// request.get(url)` really does resolve to a Response) but its declared
// type doesn't extend Promise<Response> -- a known typings gap. Composed
// here as a local intersection, once, instead of casting at every call site.
type ThenableTest = Test & Promise<Response>;

export interface TestRequest {
  get(url: string): ThenableTest;
  post(url: string): ThenableTest;
  put(url: string): ThenableTest;
  patch(url: string): ThenableTest;
  delete(url: string): ThenableTest;
}

export function testRequest(app: Application): TestRequest {
  return supertest(app) as unknown as TestRequest;
}
