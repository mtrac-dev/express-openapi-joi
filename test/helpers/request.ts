import supertest from 'supertest';
import type { Application } from 'express';
import type { Response } from 'supertest';

// @types/supertest 7.x's own Test class is thenable and chainable at
// runtime (`request.post(url).send(body)` then `await`s to a Response),
// but composing that from its real (class-based, `export =`-namespaced)
// types doesn't reliably carry every chained method through under this
// project's module settings -- confirmed against `tsc --noEmit`, not just
// the eslint quirk documented in test/.eslintrc.json. Declaring the small
// surface actually used here directly, backed by one cast at the boundary,
// sidesteps that instead of fighting it.
export interface TestCall extends Promise<Response> {
  send(data?: unknown): TestCall;
  set(field: string, value: string): TestCall;
}

export interface TestRequest {
  get(url: string): TestCall;
  post(url: string): TestCall;
  put(url: string): TestCall;
  patch(url: string): TestCall;
  delete(url: string): TestCall;
}

export function testRequest(app: Application): TestRequest {
  return supertest(app) as unknown as TestRequest;
}
