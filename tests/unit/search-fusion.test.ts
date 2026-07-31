/**
 * Reciprocal rank fusion.
 *
 * Fusing in application code instead of using `$rankFusion` exists precisely so
 * the ranking can be pinned down without a database, so these tests assert the
 * arithmetic exactly rather than just checking the order came out plausible.
 */
import { describe, expect, it } from 'vitest';

import { reciprocalRankFusion, type RankedCandidate } from '../../src/services/search-fusion.js';

/** `weight / (k + rank)`, spelled out so a regression in the formula is obvious. */
const contribution = (weight: number, k: number, rank: number): number => weight / (k + rank);

const candidates = (...ids: string[]): RankedCandidate[] =>
  ids.map((chunkId, index) => ({ chunkId, score: 1 - index * 0.01 }));

describe('reciprocalRankFusion', () => {
  it('returns nothing when both legs are empty', () => {
    expect(reciprocalRankFusion({ vector: [], text: [], k: 60, vectorWeight: 0.7 })).toEqual([]);
  });

  it('scores a vector-only leg with the vector weight and leaves text fields null', () => {
    const fused = reciprocalRankFusion({
      vector: candidates('a', 'b'),
      text: [],
      k: 60,
      vectorWeight: 0.7,
    });

    expect(fused.map((entry) => entry.chunkId)).toEqual(['a', 'b']);
    expect(fused[0]?.score).toBeCloseTo(contribution(0.7, 60, 1), 12);
    expect(fused[1]?.score).toBeCloseTo(contribution(0.7, 60, 2), 12);

    expect(fused[0]).toMatchObject({
      vectorRank: 1,
      vectorScore: 1,
      textRank: null,
      textScore: null,
    });
  });

  it('scores a text-only leg with the complementary weight', () => {
    const fused = reciprocalRankFusion({
      vector: [],
      text: candidates('a', 'b'),
      k: 60,
      vectorWeight: 0.7,
    });

    expect(fused[0]?.score).toBeCloseTo(contribution(0.3, 60, 1), 12);
    expect(fused[0]).toMatchObject({ textRank: 1, vectorRank: null, vectorScore: null });
  });

  it('adds both contributions for a chunk found by both legs', () => {
    const fused = reciprocalRankFusion({
      vector: [
        { chunkId: 'a', score: 0.82 },
        { chunkId: 'b', score: 0.79 },
      ],
      text: [
        { chunkId: 'b', score: 12.5 },
        { chunkId: 'a', score: 9.25 },
      ],
      k: 60,
      vectorWeight: 0.7,
    });

    // 'a' is first in the (heavier) vector leg and second in the text leg, so it
    // must beat 'b', which has the mirror image ranks.
    expect(fused.map((entry) => entry.chunkId)).toEqual(['a', 'b']);
    expect(fused[0]?.score).toBeCloseTo(contribution(0.7, 60, 1) + contribution(0.3, 60, 2), 12);
    expect(fused[0]).toMatchObject({
      vectorRank: 1,
      vectorScore: 0.82,
      textRank: 2,
      textScore: 9.25,
    });
  });

  it('lets an agreed-on chunk outrank one that only a single leg loved', () => {
    const fused = reciprocalRankFusion({
      vector: candidates('solo', 'agreed'),
      text: candidates('agreed', 'other'),
      k: 60,
      vectorWeight: 0.5,
    });

    expect(fused[0]?.chunkId).toBe('agreed');
  });

  it('preserves raw leg scores untouched, however incomparable they are', () => {
    const fused = reciprocalRankFusion({
      vector: [{ chunkId: 'a', score: 0.7312 }],
      text: [{ chunkId: 'a', score: 41.9 }],
      k: 60,
      vectorWeight: 0.7,
    });

    expect(fused[0]?.vectorScore).toBe(0.7312);
    expect(fused[0]?.textScore).toBe(41.9);
  });

  describe('weights', () => {
    it('ignores the text leg entirely at vectorWeight 1', () => {
      const fused = reciprocalRankFusion({
        vector: candidates('a'),
        text: candidates('z'),
        k: 60,
        vectorWeight: 1,
      });

      const byId = new Map(fused.map((entry) => [entry.chunkId, entry]));
      expect(byId.get('a')?.score).toBeCloseTo(contribution(1, 60, 1), 12);
      // Still reported — with its rank and raw score — but contributing nothing.
      expect(byId.get('z')?.score).toBe(0);
      expect(byId.get('z')?.textRank).toBe(1);
    });

    it('ignores the vector leg entirely at vectorWeight 0', () => {
      const fused = reciprocalRankFusion({
        vector: candidates('a'),
        text: candidates('z'),
        k: 60,
        vectorWeight: 0,
      });

      const byId = new Map(fused.map((entry) => [entry.chunkId, entry]));
      expect(byId.get('z')?.score).toBeCloseTo(contribution(1, 60, 1), 12);
      expect(byId.get('a')?.score).toBe(0);
      expect(byId.get('a')?.vectorRank).toBe(1);
    });

    it('clamps a weight outside [0, 1] so one leg cannot subtract from the other', () => {
      const fused = reciprocalRankFusion({
        vector: candidates('a'),
        text: candidates('z'),
        k: 60,
        vectorWeight: 4,
      });

      expect(fused.every((entry) => entry.score >= 0)).toBe(true);
      expect(fused[0]?.chunkId).toBe('a');
      expect(fused[0]?.score).toBeCloseTo(contribution(1, 60, 1), 12);
    });
  });

  describe('k', () => {
    it('flattens the curve as k grows', () => {
      const tight = reciprocalRankFusion({
        vector: candidates('a', 'b'),
        text: [],
        k: 1,
        vectorWeight: 1,
      });
      const flat = reciprocalRankFusion({
        vector: candidates('a', 'b'),
        text: [],
        k: 1000,
        vectorWeight: 1,
      });

      const tightGap = (tight[0]?.score ?? 0) - (tight[1]?.score ?? 0);
      const flatGap = (flat[0]?.score ?? 0) - (flat[1]?.score ?? 0);
      expect(flatGap).toBeLessThan(tightGap);
    });

    it('clamps a negative or non-finite k instead of dividing by zero', () => {
      const negative = reciprocalRankFusion({
        vector: candidates('a'),
        text: [],
        k: -100,
        vectorWeight: 1,
      });
      expect(negative[0]?.score).toBeCloseTo(contribution(1, 0, 1), 12);

      const nan = reciprocalRankFusion({
        vector: candidates('a'),
        text: [],
        k: Number.NaN,
        vectorWeight: 1,
      });
      expect(Number.isFinite(nan[0]?.score ?? Number.NaN)).toBe(true);
    });
  });

  it('keeps the best position for a chunk repeated inside one leg', () => {
    const fused = reciprocalRankFusion({
      vector: [
        { chunkId: 'a', score: 0.9 },
        { chunkId: 'b', score: 0.8 },
        { chunkId: 'a', score: 0.4 },
      ],
      text: [],
      k: 0,
      vectorWeight: 1,
    });

    expect(fused).toHaveLength(2);
    // 'a' keeps rank 1 and its first score; 'b' keeps rank 2 because the repeat
    // still occupies the position the search engine put it in.
    expect(fused[0]).toMatchObject({ chunkId: 'a', vectorRank: 1, vectorScore: 0.9 });
    expect(fused[0]?.score).toBeCloseTo(1, 12);
    expect(fused[1]).toMatchObject({ chunkId: 'b', vectorRank: 2 });
    expect(fused[1]?.score).toBeCloseTo(0.5, 12);
  });

  it('breaks ties on chunkId so the order is stable across calls', () => {
    const input = {
      vector: candidates('b', 'a'),
      text: candidates('a', 'b'),
      k: 60,
      vectorWeight: 0.5,
    };

    const fused = reciprocalRankFusion(input);
    expect(fused[0]?.score).toBeCloseTo(fused[1]?.score ?? 0, 12);
    expect(fused.map((entry) => entry.chunkId)).toEqual(['a', 'b']);
    expect(reciprocalRankFusion(input).map((entry) => entry.chunkId)).toEqual(['a', 'b']);
  });

  it('never mutates the input lists', () => {
    const vector = candidates('b', 'a');
    const text = candidates('a');
    const snapshot = JSON.stringify({ vector, text });

    reciprocalRankFusion({ vector, text, k: 60, vectorWeight: 0.7 });

    expect(JSON.stringify({ vector, text })).toBe(snapshot);
  });

  it('emits every chunk exactly once across both legs', () => {
    const fused = reciprocalRankFusion({
      vector: candidates('a', 'b', 'c'),
      text: candidates('c', 'd'),
      k: 60,
      vectorWeight: 0.7,
    });

    expect(new Set(fused.map((entry) => entry.chunkId)).size).toBe(4);
    expect(fused).toHaveLength(4);
  });
});
