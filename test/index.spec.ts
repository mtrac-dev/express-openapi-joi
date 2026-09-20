import { expect } from 'chai';

describe('express-openapi-joi', () => {
  it('resolves the package entrypoint', async () => {
    const lib = await import('../src/index.ts');

    expect(lib).to.exist;
  });

  it('resolves the ./typegen subpath entrypoint', async () => {
    const typegen = await import('../src/typegen/index.ts');

    expect(typegen).to.exist;
  });
});
