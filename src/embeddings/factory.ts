/**
 * Embedding provider selection.
 *
 * The single place in the application that knows a concrete provider class
 * exists. Everything downstream depends on {@link EmbeddingProvider} only, so
 * changing vendor is a config change plus a re-embedding run — see
 * `src/cli/reembed.ts` — and touches nothing in ingestion or search.
 *
 * The switch is exhaustive with a `never` check: adding a provider to the env
 * enum without wiring it up here becomes a compile error rather than a runtime
 * surprise at first ingest.
 */
import type { EmbeddingConfig } from '../config/env.js';
import { ConfigError } from '../errors.js';
import type { Logger } from '../logger.js';

import { FakeEmbeddingProvider } from './fake.js';
import type { EmbeddingProvider } from './provider.js';
import { VoyageEmbeddingProvider } from './voyage.js';

export function createEmbeddingProvider(cfg: EmbeddingConfig, logger: Logger): EmbeddingProvider {
  const provider = instantiate(cfg, logger);

  logger.info(
    {
      event: 'embedding.provider_selected',
      provider: provider.info.provider,
      model: provider.info.model,
      dimensions: provider.info.dimensions,
      contextual: provider.info.contextual,
      maxBatchSize: provider.info.maxBatchSize,
    },
    `embedding provider ${provider.info.provider}/${provider.info.model} at ${provider.info.dimensions} dimensions`,
  );

  return provider;
}

function instantiate(cfg: EmbeddingConfig, logger: Logger): EmbeddingProvider {
  switch (cfg.provider) {
    case 'voyage':
      return new VoyageEmbeddingProvider(cfg, logger);

    case 'fake':
      // The fake still reports the configured model and dimensions: provenance
      // stamped on a chunk has to match what a later re-embed run compares
      // against, and the vector length has to match the Atlas index either way.
      return new FakeEmbeddingProvider({
        dimensions: cfg.dimensions,
        model: cfg.model,
        contextual: cfg.contextual,
      });

    default: {
      const unreachable: never = cfg.provider;
      throw new ConfigError(`Unsupported embedding provider: ${String(unreachable)}`);
    }
  }
}
