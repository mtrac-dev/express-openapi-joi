import supertest from 'supertest';
import type { Application } from 'express';
import type { Response } from 'supertest';

// The parts of supertest's Test used by the specs. Its own types don't keep
// every chained method under this project's module settings.
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
