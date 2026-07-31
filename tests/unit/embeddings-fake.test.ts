/**
 * FakeEmbeddingProvider unit tests.
 *
 * The integration suite runs real `$vectorSearch` against vectors produced by
 * this provider, so "is it deterministic and unit-length" is necessary but not
 * sufficient. The load-bearing test here is the similarity margin: shared
 * vocabulary must score materially higher than disjoint vocabulary, or every
 * downstream ranking assertion is measuring noise.
 */
import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../src/errors.js';
import { FakeEmbeddingProvider } from '../../src/embeddings/fake.js';

const DIMENSIONS = 1024;

function makeProvider(contextual = false, dimensions = DIMENSIONS): FakeEmbeddingProvider {
  return new FakeEmbeddingProvider({ dimensions, contextual });
}

/** Both operands are L2-normalised, so the dot product is the cosine. */
function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

function norm(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
}

/**
 * Indices of the `k` largest components by magnitude, sorted.
 *
 * A term occupies one dimension per hash probe and all of its probes carry the
 * same weight, so "which single dimension is largest" is a coin flip between
 * them. The stable, meaningful property is the *set* of dimensions the strongest
 * term owns.
 */
function topIndices(vector: readonly number[], k: number): number[] {
  return vector
    .map((value, index) => ({ index, magnitude: Math.abs(value) }))
    .sort((a, b) => b.magnitude - a.magnitude)
    .slice(0, k)
    .map((entry) => entry.index)
    .sort((a, b) => a - b);
}

async function embedOne(provider: FakeEmbeddingProvider, text: string): Promise<number[]> {
  const result = await provider.embedQueries([text]);
  const vector = result.embeddings[0];
  if (!vector) throw new Error('expected one embedding');
  return vector;
}

describe('shape and determinism', () => {
  it('produces vectors of exactly the configured dimension', async () => {
    const provider = makeProvider(false, 256);
    const result = await provider.embedDocumentChunks([['hello world', 'second chunk']]);
    for (const vector of result.embeddings.flat()) {
      expect(vector).toHaveLength(256);
    }
    expect(provider.info.dimensions).toBe(256);
  });

  it('mirrors the input shape exactly', async () => {
    const result = await makeProvider().embedDocumentChunks([
      ['a one', 'a two', 'a three'],
      ['b one'],
      ['c one', 'c two'],
    ]);
    expect(result.embeddings.map((group) => group.length)).toEqual([3, 1, 2]);
  });

  it('is deterministic across separate instances', async () => {
    const first = await makeProvider().embedDocumentChunks([['mongodb aggregation pipeline']]);
    const second = await makeProvider().embedDocumentChunks([['mongodb aggregation pipeline']]);
    expect(first.embeddings).toEqual(second.embeddings);
  });

  it('emits unit-length vectors', async () => {
    const provider = makeProvider();
    for (const text of ['short', 'a much longer sentence with several distinct words', '42']) {
      expect(norm(await embedOne(provider, text))).toBeCloseTo(1, 12);
    }
  });

  it('reports its own token count and zero upstream requests', async () => {
    const result = await makeProvider().embedDocumentChunks([['one two three', 'four five']]);
    expect(result.usage).toEqual({ totalTokens: 5, requests: 0 });
  });

  it('close() is idempotent', async () => {
    const provider = makeProvider();
    await expect(provider.close()).resolves.toBeUndefined();
    await expect(provider.close()).resolves.toBeUndefined();
  });
});

describe('semantic behaviour', () => {
  it('scores shared vocabulary far above disjoint vocabulary', async () => {
    const provider = makeProvider();

    const anchor = await embedOne(
      provider,
      'MongoDB aggregation pipelines group and project documents in stages',
    );
    const related = await embedOne(
      provider,
      'Aggregation pipelines in MongoDB project documents through several stages',
    );
    const unrelated = await embedOne(
      provider,
      'Volcanic basalt columns cool slowly and fracture into hexagonal prisms',
    );

    const relatedScore = cosine(anchor, related);
    const unrelatedScore = cosine(anchor, unrelated);

    expect(relatedScore).toBeGreaterThan(0.6);
    expect(Math.abs(unrelatedScore)).toBeLessThan(0.2);
    // The margin is what makes "the chunk about X ranks first" a real assertion.
    expect(relatedScore - unrelatedScore).toBeGreaterThan(0.4);
  });

  it('is insensitive to case and punctuation', async () => {
    const provider = makeProvider();
    const plain = await embedOne(provider, 'vector search');
    const noisy = await embedOne(provider, '  Vector, SEARCH!!  ');
    expect(cosine(plain, noisy)).toBeCloseTo(1, 12);
  });

  it('weights repeated terms sublinearly rather than linearly', async () => {
    const provider = makeProvider();
    const once = await embedOne(provider, 'alpha beta gamma delta');
    const repeated = await embedOne(provider, `${'alpha '.repeat(8)}beta gamma delta`);
    // Repetition shifts the vector toward `alpha` but must not obliterate the rest.
    expect(cosine(once, repeated)).toBeGreaterThan(0.5);
    expect(cosine(once, repeated)).toBeLessThan(0.999);
  });
});

describe('degenerate input', () => {
  it('rejects blank chunks and empty documents the way Voyage does', async () => {
    const provider = makeProvider();
    await expect(provider.embedDocumentChunks([[]])).rejects.toBeInstanceOf(ValidationError);
    await expect(provider.embedDocumentChunks([['ok', '   ']])).rejects.toThrow(
      /documents\[0\]\[1\] is empty/,
    );
    await expect(provider.embedQueries(['\t\n '])).rejects.toBeInstanceOf(ValidationError);
  });

  it('gives text with no word characters a fixed deterministic unit vector', async () => {
    const provider = makeProvider();
    const symbols = await embedOne(provider, '### --- ###');
    const otherSymbols = await embedOne(provider, '!!! ???');

    expect(norm(symbols)).toBeCloseTo(1, 12);
    expect(symbols).toEqual(otherSymbols);
    expect(symbols.some((value) => value !== 0)).toBe(true);
  });

  it('returns an empty result for empty input', async () => {
    const provider = makeProvider();
    await expect(provider.embedDocumentChunks([])).resolves.toMatchObject({ embeddings: [] });
    await expect(provider.embedQueries([])).resolves.toMatchObject({ embeddings: [] });
  });
});

describe('contextual blending', () => {
  // Chunk 0 leans hard on one term so "the strongest term" is unambiguous, and
  // the siblings are about something else entirely so the centroid actually pulls.
  const document = [
    `${'sharding '.repeat(20)}distributes documents across the shard key`,
    'replica sets keep secondaries in sync with the primary through the oplog',
    'change streams let an application tail the oplog without polling',
  ];

  it('changes chunk vectors but keeps the chunk itself dominant', async () => {
    const plain = await makeProvider(false).embedDocumentChunks([document]);
    const blended = await makeProvider(true).embedDocumentChunks([document]);

    const plainChunks = plain.embeddings[0];
    const blendedChunks = blended.embeddings[0];
    if (!plainChunks || !blendedChunks) throw new Error('expected one document group');

    plainChunks.forEach((plainVector, index) => {
      const blendedVector = blendedChunks[index];
      if (!blendedVector) throw new Error(`missing blended chunk ${index}`);

      expect(blendedVector).not.toEqual(plainVector);
      expect(norm(blendedVector)).toBeCloseTo(1, 12);
      // The chunk's own signal still dominates the document centroid.
      expect(cosine(plainVector, blendedVector)).toBeGreaterThan(0.9);
    });
  });

  it('preserves the ranking of the strongest term', async () => {
    const plain = await makeProvider(false).embedDocumentChunks([document]);
    const blended = await makeProvider(true).embedDocumentChunks([document]);

    const plainFirst = plain.embeddings[0]?.[0];
    const blendedFirst = blended.embeddings[0]?.[0];
    if (!plainFirst || !blendedFirst) throw new Error('expected a first chunk');

    // Three probes per token, so the top three dimensions are exactly the ones
    // "sharding" owns. Blending must not dislodge them.
    expect(topIndices(blendedFirst, 3)).toEqual(topIndices(plainFirst, 3));
  });

  it('leaves single-chunk documents and all queries unblended', async () => {
    const contextual = makeProvider(true);
    const plain = makeProvider(false);

    const single = 'a lone chunk with no siblings to be conditioned on';
    const contextualDoc = await contextual.embedDocumentChunks([[single]]);
    const plainDoc = await plain.embedDocumentChunks([[single]]);
    expect(contextualDoc.embeddings).toEqual(plainDoc.embeddings);

    // A query has no siblings either, so both providers must agree exactly.
    expect(await embedOne(contextual, single)).toEqual(await embedOne(plain, single));
  });
});
