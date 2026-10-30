import express from 'express';
import { expect } from 'chai';

import { defineRoute, routeRegistry } from '../src/globalRegistry.ts';

describe('UNIT: global defineRoute/routeRegistry', () => {
  // The global registry is shared across spec files, so restore its length
  // after the test instead of emptying it.
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
