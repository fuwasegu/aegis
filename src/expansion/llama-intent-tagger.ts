/**
 * LlamaIntentTagger — IntentTagger implementation using local llama.cpp engine.
 *
 * Uses grammar-constrained JSON generation to guarantee valid output format.
 * Falls back to empty tags on any error (graceful degradation).
 */

import type { IntentTagger } from '../core/tagging/tagger.js';
import type { IntentTag } from '../core/types.js';
import type { LlamaEngine } from './llama-engine.js';

const SYSTEM_PROMPT_TEMPLATE = `You are an intent classifier for a software architecture enforcement system.
Given a developer's plan, extract relevant intent tags from the following list:

KNOWN TAGS: {{TAGS}}

Rules:
- Only return tags from the KNOWN TAGS list above.
- Return tags that are relevant to the plan.
- If no tags match, return an empty array.
- Respond ONLY with a JSON object in this format: {"tags": ["tag1", "tag2"]}
- Do not include any explanation or text outside the JSON.`;

export class LlamaIntentTagger implements IntentTagger {
  constructor(private engine: LlamaEngine) {}

  async extractTags(plan: string, knownTags: string[]): Promise<IntentTag[]> {
    if (knownTags.length === 0) return [];

    const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('{{TAGS}}', knownTags.join(', '));

    try {
      const result = await this.engine.generateJson<{ tags?: string[] }>(plan, {
        systemPrompt,
        temperature: 0.1,
        maxTokens: 256,
      });

      if (!result || !Array.isArray(result.tags)) return [];

      return result.tags
        .filter((tag) => typeof tag === 'string' && knownTags.includes(tag))
        .map((tag) => ({
          tag,
          confidence: 0.8,
          reasoning: `Extracted by ${this.engine.modelName} (llama.cpp)`,
        }));
    } catch {
      return [];
    }
  }
}
