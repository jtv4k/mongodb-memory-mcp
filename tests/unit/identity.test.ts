/**
 * `domainAncestors` unit tests.
 *
 * The materialised ancestor chain is what lets a domain filter get prefix
 * semantics from a plain array-contains-value query — see the module doc in
 * src/services/knowledge-service.ts's filter builders. This is the one pure,
 * easily-wrong piece: get the split/cumulative-join logic wrong and every
 * domain-filtered search or list silently narrows to the wrong set.
 */
import { describe, expect, it } from 'vitest';

import { domainAncestors } from '../../src/services/identity.js';

describe('domainAncestors', () => {
  it('returns an empty array for a null domain', () => {
    expect(domainAncestors(null)).toEqual([]);
  });

  it('returns the domain itself for a single segment', () => {
    expect(domainAncestors('docs')).toEqual(['docs']);
  });

  it('builds the full cumulative chain for a multi-segment path', () => {
    expect(domainAncestors('docs/api/v1')).toEqual(['docs', 'docs/api', 'docs/api/v1']);
  });

  it('preserves case — domain is case-sensitive, unlike tags', () => {
    expect(domainAncestors('Docs/API')).toEqual(['Docs', 'Docs/API']);
  });

  it('does not conflate a real prefix with an unrelated string sharing one', () => {
    // "docs/api" must not appear as an ancestor of "docs/apiary" — a naive
    // string-prefix check would get this wrong; splitting on segments does not.
    expect(domainAncestors('docs/apiary')).toEqual(['docs', 'docs/apiary']);
    expect(domainAncestors('docs/apiary')).not.toContain('docs/api');
  });
});
