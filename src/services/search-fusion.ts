/**
 * Reciprocal rank fusion for hybrid search.
 *
 * ## Why RRF instead of normalising and adding the raw scores
 *
 * The two halves of a hybrid search produce numbers that live in different
 * universes. `$vectorSearch` returns a cosine similarity mapped into `[0, 1]`,
 * where a *good* hit is often 0.75 and a *bad* one 0.68 — a narrow, compressed
 * band. `$search` returns a Lucene BM25 score, which is unbounded, corpus- and
 * query-dependent, and routinely differs by an order of magnitude between two
 * queries against the same index. There is no fixed transform between them:
 * min-max normalising per result set makes the top hit of a terrible leg score
 * 1.0, and z-scoring assumes a distribution neither leg has.
 *
 * RRF sidesteps the problem by throwing the magnitudes away and keeping only the
 * thing both legs agree on — *ordering*. Each leg contributes
 * `weight / (k + rank)`, so being 1st matters a lot more than being 10th, being
 * 40th vs 50th barely registers, and a document that both legs like beats one
 * that only one leg loves. `k` (default 60, the value from the original Cormack
 * et al. paper) damps the head of the curve so a single leg cannot dominate on
 * the strength of one lucky first place.
 *
 * The cost is that raw scores no longer mean anything in the fused output, which
 * is why {@link FusedCandidate} carries `vectorScore`/`textScore` unchanged for
 * display and debugging.
 *
 * Pure, synchronous, no I/O — the whole point of fusing in the application
 * rather than using `$rankFusion` is that this behaves identically on Atlas Local
 * and cloud Atlas, and can be unit tested exhaustively.
 */

/** One leg's view of a chunk: its id and that leg's own relevance score. */
export interface RankedCandidate {
  chunkId: string;
  score: number;
}

export interface FusedCandidate {
  chunkId: string;
  /** The fused RRF score. Comparable only against other results of this call. */
  score: number;
  /** The leg's raw score, or null when that leg did not retrieve this chunk. */
  vectorScore: number | null;
  textScore: number | null;
  /** 1-based position within the leg, or null when that leg missed the chunk. */
  vectorRank: number | null;
  textRank: number | null;
}

export interface ReciprocalRankFusionInput {
  /** Vector-leg candidates, already in descending relevance order. */
  vector: readonly RankedCandidate[];
  /** Text-leg candidates, already in descending relevance order. */
  text: readonly RankedCandidate[];
  /** Smoothing constant; larger flattens the curve. Negative values are clamped. */
  k: number;
  /** Vector share of the fused score in `[0, 1]`; text gets `1 - vectorWeight`. */
  vectorWeight: number;
}

/**
 * Fuse two ranked lists into one.
 *
 * Rank is the *position in the supplied list*, so the caller is responsible for
 * handing over each leg in the order its search stage produced. A chunk repeated
 * inside one list keeps its first (best) position and the repeat is ignored;
 * it still consumes a rank slot, because that is where the search engine put it.
 *
 * The result is sorted by fused score descending with a lexicographic tie-break
 * on `chunkId`, so equal scores never reorder between calls — pagination and
 * snapshot tests both depend on that.
 */
export function reciprocalRankFusion(input: ReciprocalRankFusionInput): FusedCandidate[] {
  const k = Number.isFinite(input.k) ? Math.max(0, input.k) : 0;
  const vectorWeight = clampWeight(input.vectorWeight);
  const fused = new Map<string, FusedCandidate>();

  const accumulate = (
    candidates: readonly RankedCandidate[],
    weight: number,
    leg: 'vector' | 'text',
  ): void => {
    const seen = new Set<string>();

    for (let position = 0; position < candidates.length; position += 1) {
      const candidate = candidates[position];
      if (!candidate || seen.has(candidate.chunkId)) continue;
      seen.add(candidate.chunkId);

      const rank = position + 1;
      const entry = fused.get(candidate.chunkId) ?? blankCandidate(candidate.chunkId);
      entry.score += weight / (k + rank);

      if (leg === 'vector') {
        entry.vectorScore = candidate.score;
        entry.vectorRank = rank;
      } else {
        entry.textScore = candidate.score;
        entry.textRank = rank;
      }

      fused.set(candidate.chunkId, entry);
    }
  };

  accumulate(input.vector, vectorWeight, 'vector');
  accumulate(input.text, 1 - vectorWeight, 'text');

  return [...fused.values()].sort(byScoreThenId);
}

function blankCandidate(chunkId: string): FusedCandidate {
  return {
    chunkId,
    score: 0,
    vectorScore: null,
    textScore: null,
    vectorRank: null,
    textRank: null,
  };
}

function byScoreThenId(a: FusedCandidate, b: FusedCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.chunkId === b.chunkId) return 0;
  return a.chunkId < b.chunkId ? -1 : 1;
}

/** A weight outside `[0, 1]` would make one leg subtract from the other. */
function clampWeight(weight: number): number {
  if (!Number.isFinite(weight)) return 0.5;
  return Math.min(1, Math.max(0, weight));
}
