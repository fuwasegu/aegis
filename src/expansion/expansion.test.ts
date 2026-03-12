import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaClient, OllamaError, DEFAULT_OLLAMA_CONFIG } from './ollama-client.js';
import { OllamaIntentTagger } from './intent-tagger.js';

describe('OllamaClient', () => {
  it('uses default config', () => {
    const client = new OllamaClient();
    expect(client.modelName).toBe(DEFAULT_OLLAMA_CONFIG.model);
  });

  it('accepts partial config override', () => {
    const client = new OllamaClient({ model: 'custom:7b' });
    expect(client.modelName).toBe('custom:7b');
  });

  it('isHealthy returns false when server is unreachable', async () => {
    const client = new OllamaClient({ baseUrl: 'http://localhost:1' });
    expect(await client.isHealthy()).toBe(false);
  });

  it('hasModel returns false when server is unreachable', async () => {
    const client = new OllamaClient({ baseUrl: 'http://localhost:1' });
    expect(await client.hasModel()).toBe(false);
  });

  it('generate throws OllamaError on connection failure', async () => {
    const client = new OllamaClient({
      baseUrl: 'http://localhost:1',
      maxRetries: 0,
      timeoutMs: 1000,
    });
    await expect(client.generate('hello')).rejects.toThrow(OllamaError);
  });
});

describe('OllamaIntentTagger', () => {
  const knownTags = ['state_mutation', 'collection_operation', 'db_migration', 'api_endpoint'];

  it('returns empty tags when client is unavailable', async () => {
    const client = new OllamaClient({ baseUrl: 'http://localhost:1', maxRetries: 0, timeoutMs: 1000 });
    const tagger = new OllamaIntentTagger(client, knownTags);
    const result = await tagger.extractTags('Add a bookmark sorting feature');
    expect(result).toEqual([]);
  });

  it('parses valid JSON response from generate', async () => {
    const mockClient = {
      generate: vi.fn().mockResolvedValue(JSON.stringify({
        tags: ['state_mutation', 'collection_operation'],
      })),
      modelName: 'test-model',
      isHealthy: vi.fn().mockResolvedValue(true),
    } as any;

    const tagger = new OllamaIntentTagger(mockClient, knownTags);
    const result = await tagger.extractTags('Sort bookmarks by creation date');

    expect(result).toHaveLength(2);
    expect(result[0].tag).toBe('state_mutation');
    expect(result[1].tag).toBe('collection_operation');
    expect(result.every(t => t.confidence > 0)).toBe(true);
  });

  it('filters out unknown tags', async () => {
    const mockClient = {
      generate: vi.fn().mockResolvedValue(JSON.stringify({
        tags: ['state_mutation', 'unknown_tag', 'collection_operation'],
      })),
      modelName: 'test-model',
    } as any;

    const tagger = new OllamaIntentTagger(mockClient, knownTags);
    const result = await tagger.extractTags('Do something');

    expect(result).toHaveLength(2);
    expect(result.map(t => t.tag)).toEqual(['state_mutation', 'collection_operation']);
  });

  it('handles malformed JSON gracefully', async () => {
    const mockClient = {
      generate: vi.fn().mockResolvedValue('not valid json {{{'),
      modelName: 'test-model',
    } as any;

    const tagger = new OllamaIntentTagger(mockClient, knownTags);
    const result = await tagger.extractTags('Do something');
    expect(result).toEqual([]);
  });

  it('handles JSON without tags field', async () => {
    const mockClient = {
      generate: vi.fn().mockResolvedValue(JSON.stringify({ foo: 'bar' })),
      modelName: 'test-model',
    } as any;

    const tagger = new OllamaIntentTagger(mockClient, knownTags);
    const result = await tagger.extractTags('Do something');
    expect(result).toEqual([]);
  });

  it('passes known tags in system prompt', async () => {
    const mockClient = {
      generate: vi.fn().mockResolvedValue(JSON.stringify({ tags: [] })),
      modelName: 'test-model',
    } as any;

    const tagger = new OllamaIntentTagger(mockClient, knownTags);
    await tagger.extractTags('Plan text');

    const callArgs = mockClient.generate.mock.calls[0];
    expect(callArgs[1].system).toContain('state_mutation');
    expect(callArgs[1].system).toContain('collection_operation');
    expect(callArgs[1].jsonMode).toBe(true);
  });
});
