import { expect } from 'chai';

describe('express-openapi-joi', () => {
  it('resolves the package entrypoint', async () => {
    const lib = await import('../src/index.ts');

    expect(lib).to.exist;
  });
});
