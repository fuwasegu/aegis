/**
 * Llama Engine — node-llama-cpp wrapper for Aegis SLM inference.
 *
 * Manages model lifecycle: download (via resolveModelFile), load, inference, dispose.
 * Models are stored in ~/.aegis/models/ and shared across all projects.
 */

import { getLlama, resolveModelFile, LlamaChatSession } from 'node-llama-cpp';
import type { Llama, LlamaModel, LlamaContext } from 'node-llama-cpp';
import { getModelsDirectory, resolveModelUri, DEFAULT_MODEL } from './models.js';

export interface LlamaEngineConfig {
  model: string;
  modelsDir?: string;
  contextSize?: number;
}

export class LlamaEngine {
  private config: Required<LlamaEngineConfig>;
  private llama: Llama | null = null;
  private model: LlamaModel | null = null;
  private context: LlamaContext | null = null;

  constructor(config?: Partial<LlamaEngineConfig>) {
    this.config = {
      model: config?.model ?? DEFAULT_MODEL,
      modelsDir: config?.modelsDir ?? getModelsDirectory(),
      contextSize: config?.contextSize ?? 2048,
    };
  }

  async initialize(): Promise<void> {
    const modelUri = resolveModelUri(this.config.model);

    console.error(`[aegis] Resolving model: ${this.config.model} → ${modelUri}`);
    console.error(`[aegis] Models directory: ${this.config.modelsDir}`);

    const modelPath = await resolveModelFile(modelUri, this.config.modelsDir);
    console.error(`[aegis] Model ready: ${modelPath}`);

    this.llama = await getLlama();
    this.model = await this.llama.loadModel({ modelPath });
    this.context = await this.model.createContext({
      contextSize: this.config.contextSize,
    });
  }

  async generate(prompt: string, options?: {
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<string> {
    if (!this.context) {
      throw new LlamaEngineError('Engine not initialized. Call initialize() first.');
    }

    const session = new LlamaChatSession({
      contextSequence: this.context.getSequence(),
      systemPrompt: options?.systemPrompt,
    });

    try {
      return await session.prompt(prompt, {
        maxTokens: options?.maxTokens ?? 256,
        temperature: options?.temperature ?? 0.1,
      });
    } finally {
      session.dispose();
    }
  }

  async generateJson<T = unknown>(prompt: string, options?: {
    systemPrompt?: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<T> {
    if (!this.llama || !this.context) {
      throw new LlamaEngineError('Engine not initialized. Call initialize() first.');
    }

    const grammar = await this.llama.createGrammarForJsonSchema({
      type: 'object',
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    });

    const session = new LlamaChatSession({
      contextSequence: this.context.getSequence(),
      systemPrompt: options?.systemPrompt,
    });

    try {
      const response = await session.prompt(prompt, {
        grammar,
        maxTokens: options?.maxTokens ?? 256,
        temperature: options?.temperature ?? 0.1,
      });
      return grammar.parse(response) as T;
    } finally {
      session.dispose();
    }
  }

  get modelName(): string {
    return this.config.model;
  }

  get isReady(): boolean {
    return this.context !== null;
  }

  async dispose(): Promise<void> {
    if (this.context) {
      await this.context.dispose();
      this.context = null;
    }
    if (this.model) {
      await this.model.dispose();
      this.model = null;
    }
    if (this.llama) {
      await this.llama.dispose();
      this.llama = null;
    }
  }
}

export class LlamaEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlamaEngineError';
  }
}
