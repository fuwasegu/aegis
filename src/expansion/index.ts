// llama.cpp engine (default)
export { LlamaEngine, LlamaEngineError } from './llama-engine.js';
export type { LlamaEngineConfig } from './llama-engine.js';
export { LlamaIntentTagger } from './llama-intent-tagger.js';
export { MODEL_CATALOG, DEFAULT_MODEL, getModelsDirectory, resolveModelUri, listAvailableModels } from './models.js';
export type { ModelEntry } from './models.js';

// Ollama (legacy fallback)
export { OllamaClient, OllamaError, DEFAULT_OLLAMA_CONFIG } from './ollama-client.js';
export type { OllamaConfig } from './ollama-client.js';
export { OllamaIntentTagger } from './intent-tagger.js';
