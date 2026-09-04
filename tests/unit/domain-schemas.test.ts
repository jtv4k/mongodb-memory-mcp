import { describe, it, expect } from 'vitest';
import {
  storeContentSchema,
  searchFiltersSchema,
  deleteContentSchema,
  listSourcesSchema,
} from '../../src/domain/schemas.js';

describe('Domain Schema Validation Tests', () => {
  it('should validate store_content with domain', () => {
    const validInput = {
      content: 'Test content',
      sourceId: 'test-source',
      domain: 'docs/api/v1',
      title: 'Test Title',
      contentType: 'markdown',
    };

    const result = storeContentSchema.safeParse(validInput);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.domain).toBe('docs/api/v1');
    }
  });

  it('should validate search filters with domain', () => {
    const validInput = {
      sourceIds: ['test-source'],
      domain: 'docs/api/v1',
      tags: ['tag1'],
    };

    const result = searchFiltersSchema.safeParse(validInput);
    expect(result.success).toBe(true);

    if (result.success) {
      // `searchFiltersSchema` is itself `.optional()`, so `data` is
      // `T | undefined` at the type level even though this input parses to a
      // real object.
      expect(result.data?.domain).toBe('docs/api/v1');
    }
  });

  it('should validate delete_content with domain', () => {
    const validInput = {
      domain: 'docs/api/v1',
    };

    const result = deleteContentSchema.safeParse(validInput);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.domain).toBe('docs/api/v1');
    }
  });

  it('should validate list_sources with domain', () => {
    const validInput = {
      limit: 10,
      offset: 0,
      domain: 'docs/api/v1',
    };

    const result = listSourcesSchema.safeParse(validInput);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.data.domain).toBe('docs/api/v1');
    }
  });

  it('should reject invalid domain format', () => {
    const invalidInput = {
      content: 'Test content',
      domain: 'invalid/domain/with/special@chars',
      title: 'Test Title',
      contentType: 'markdown',
    };

    const result = storeContentSchema.safeParse(invalidInput);
    expect(result.success).toBe(false);
  });

  it('should allow empty domain (optional)', () => {
    const validInput = {
      content: 'Test content',
      title: 'Test Title',
      contentType: 'markdown',
    };

    const result = storeContentSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });
});
