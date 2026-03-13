/**
 * Curated SLM Model Catalog for Aegis Intent Tagging
 *
 * Models are stored in ~/.aegis/models/ (shared across all projects).
 * node-llama-cpp's resolveModelFile handles downloading from HuggingFace.
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ModelEntry {
  uri: string;
  description: string;
  sizeHint: string;
}

export const MODEL_CATALOG: Record<string, ModelEntry> = {
  'qwen3.5-4b': {
    uri: 'hf:unsloth/Qwen3.5-4B-GGUF:Qwen3.5-4B-Q4_K_M.gguf',
    description: 'Qwen 3.5 4B (Q4_K_M) — recommended default, fast and lightweight',
    sizeHint: '~2.5 GB',
  },
  'qwen3.5-9b': {
    uri: 'hf:unsloth/Qwen3.5-9B-GGUF:Qwen3.5-9B-Q4_K_M.gguf',
    description: 'Qwen 3.5 9B (Q4_K_M) — higher quality, benchmark-topping',
    sizeHint: '~5.5 GB',
  },
};

export const DEFAULT_MODEL = 'qwen3.5-4b';

export function getModelsDirectory(): string {
  const dir = join(homedir(), '.aegis', 'models');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function resolveModelUri(nameOrUri: string): string {
  const catalogEntry = MODEL_CATALOG[nameOrUri];
  if (catalogEntry) return catalogEntry.uri;
  return nameOrUri;
}

export function listAvailableModels(): string[] {
  return Object.keys(MODEL_CATALOG);
}
