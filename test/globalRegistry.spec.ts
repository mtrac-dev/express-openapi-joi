import express from 'express';
import { expect } from 'chai';

import { defineRoute, routeRegistry } from '../src/globalRegistry.ts';

describe('UNIT: global defineRoute/routeRegistry', () => {
  // routeRegistry here is the library's one process-wide instance -- unlike
  // every other spec file (each of which builds its own isolated registry
  // via createRouteRegistry()), truncate back to the length recorded before
  // this test, not to zero, so this doesn't leak into whichever other spec
  // file runs next.
  let initialLength: number;
  beforeEach(() => {
    initialLength = routeRegistry.length;
  });
  afterEach(() => {
    routeRegistry.length = initialLength;
  });

  it('registers a route against the shared, process-wide registry', () => {
    defineRoute(express.Router(), {
      method: 'get',
      path: '/',
      prefix: '/widgets',
      summary: 'List widgets',
      handler: (_req, res) => res.status(200).json([]),
    });

    expect(routeRegistry).to.have.lengthOf(initialLength + 1);
    expect(routeRegistry.at(-1)).to.include({
      docPath: '/widgets',
      summary: 'List widgets',
    });
  });
});
