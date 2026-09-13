import { expect } from 'chai';

import { inferSecurity, mergeSecurity, securedBy } from '../src/security.ts';

describe('UNIT: security', () => {
  describe('securedBy / inferSecurity', () => {
    it('tags a middleware function with its scheme, readable back via inferSecurity', () => {
      const apiKeyAuth = securedBy(() => undefined, 'ApiKeyAuth');

      expect(inferSecurity([apiKeyAuth])).to.eql(['ApiKeyAuth']);
    });

    it('ignores untagged middleware', () => {
      const plain = () => undefined;

      expect(inferSecurity([plain])).to.eql([]);
    });

    it('defaults to an empty array when no middleware is given', () => {
      expect(inferSecurity()).to.eql([]);
    });
  });

  describe('mergeSecurity', () => {
    it('converts a scheme name to a requirement object with an empty scope list', () => {
      expect(mergeSecurity(undefined, ['ApiKeyAuth'])).to.eql([
        { ApiKeyAuth: [] },
      ]);
    });

    it("converts 'public' to an empty requirement object", () => {
      expect(mergeSecurity(undefined, ['public'])).to.eql([{}]);
    });

    it('unions across calls instead of the later one overwriting the former', () => {
      const first = mergeSecurity(undefined, ['ApiKeyAuth']);
      const merged = mergeSecurity(first, ['public']);

      expect(merged).to.have.deep.members([{ ApiKeyAuth: [] }, {}]);
    });

    it('de-duplicates an identical requirement stated more than once', () => {
      const first = mergeSecurity(undefined, ['ApiKeyAuth']);
      const merged = mergeSecurity(first, ['ApiKeyAuth']);

      expect(merged).to.eql([{ ApiKeyAuth: [] }]);
    });

    it('returns an empty array when nothing has been stated', () => {
      expect(mergeSecurity(undefined, undefined)).to.eql([]);
    });
  });
});
