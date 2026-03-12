export interface OllamaConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
}

export interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  system?: string;
  format?: 'json';
  stream: false;
  options?: {
    temperature?: number;
    num_predict?: number;
  };
}

export interface OllamaGenerateResponse {
  model: string;
  response: string;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

export const DEFAULT_OLLAMA_CONFIG: OllamaConfig = {
  baseUrl: 'http://localhost:11434',
  model: 'qwen3:1.7b',
  timeoutMs: 30_000,
  maxRetries: 2,
};

export class OllamaClient {
  private config: OllamaConfig;

  constructor(config?: Partial<OllamaConfig>) {
    this.config = { ...DEFAULT_OLLAMA_CONFIG, ...config };
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async hasModel(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return false;
      const data = await response.json() as { models?: Array<{ name: string }> };
      return data.models?.some(m => m.name.startsWith(this.config.model)) ?? false;
    } catch {
      return false;
    }
  }

  async generate(prompt: string, options?: {
    system?: string;
    jsonMode?: boolean;
    temperature?: number;
    maxTokens?: number;
  }): Promise<string> {
    const body: OllamaGenerateRequest = {
      model: this.config.model,
      prompt,
      stream: false,
      ...(options?.system && { system: options.system }),
      ...(options?.jsonMode && { format: 'json' as const }),
      options: {
        ...(options?.temperature !== undefined && { temperature: options.temperature }),
        ...(options?.maxTokens !== undefined && { num_predict: options.maxTokens }),
      },
    };

    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.config.baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.timeoutMs),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => 'unknown');
          throw new OllamaError(`Ollama API error ${response.status}: ${text}`);
        }

        const data = await response.json() as OllamaGenerateResponse;
        return data.response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.config.maxRetries) {
          await sleep(Math.pow(2, attempt) * 500);
        }
      }
    }

    throw new OllamaError(
      `Ollama request failed after ${this.config.maxRetries + 1} attempts: ${lastError?.message}`,
    );
  }

  get modelName(): string {
    return this.config.model;
  }
}

export class OllamaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OllamaError';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
