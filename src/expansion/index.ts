// llama.cpp engine (default)

export { OllamaIntentTagger } from './intent-tagger.js';
export type { LlamaEngineConfig } from './llama-engine.js';
export { LlamaEngine, LlamaEngineError } from './llama-engine.js';
export { LlamaIntentTagger } from './llama-intent-tagger.js';
export type { ModelEntry } from './models.js';
export { DEFAULT_MODEL, getModelsDirectory, listAvailableModels, MODEL_CATALOG, resolveModelUri } from './models.js';
export type { OllamaConfig } from './ollama-client.js';
// Ollama (legacy fallback)
export { DEFAULT_OLLAMA_CONFIG, OllamaClient, OllamaError } from './ollama-client.js';
