/**
 * Typed collection accessors.
 *
 * Always go through these helpers rather than `db.collection('chunks')` so the
 * collection names live in exactly one place and every query is typed against
 * the real document shape.
 */
import type { Collection, Db } from 'mongodb';

import type { ChunkDoc, DocumentDoc } from '../domain/types.js';

export const COLLECTIONS = {
  documents: 'documents',
  chunks: 'chunks',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

export function documentsCollection(db: Db): Collection<DocumentDoc> {
  return db.collection<DocumentDoc>(COLLECTIONS.documents);
}

export function chunksCollection(db: Db): Collection<ChunkDoc> {
  return db.collection<ChunkDoc>(COLLECTIONS.chunks);
}

/**
 * Projection that excludes the embedding vector.
 *
 * Reading 1024 floats per chunk is pure waste for anything but a similarity
 * computation, and it bloats logs and HTTP responses. Use this everywhere the
 * vector itself is not needed.
 */
export const CHUNK_VIEW_PROJECTION = { embedding: 0 } as const;
