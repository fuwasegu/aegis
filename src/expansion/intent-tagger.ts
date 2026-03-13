import type { IntentTagger } from '../core/tagging/tagger.js';
import type { IntentTag } from '../core/types.js';
import type { OllamaClient } from './ollama-client.js';

const SYSTEM_PROMPT_TEMPLATE = `You are an intent classifier for a software architecture enforcement system.
Given a developer's plan, extract relevant intent tags from the following list:

KNOWN TAGS: {{TAGS}}

Rules:
- Only return tags from the KNOWN TAGS list above.
- Return tags that are relevant to the plan.
- If no tags match, return an empty array.
- Respond ONLY with a JSON object in this format: {"tags": ["tag1", "tag2"]}
- Do not include any explanation or text outside the JSON.`;

export class OllamaIntentTagger implements IntentTagger {
  constructor(private client: OllamaClient) {}

  async extractTags(plan: string, knownTags: string[]): Promise<IntentTag[]> {
    if (knownTags.length === 0) return [];

    const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('{{TAGS}}', knownTags.join(', '));

    let response: string;
    try {
      response = await this.client.generate(plan, {
        system: systemPrompt,
        jsonMode: true,
        temperature: 0.1,
        maxTokens: 256,
      });
    } catch {
      return [];
    }

    return this.parseResponse(response, knownTags);
  }

  private parseResponse(raw: string, knownTags: string[]): IntentTag[] {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.tags)) return [];

      return parsed.tags
        .filter((t: unknown): t is string => typeof t === 'string' && knownTags.includes(t))
        .map((tag: string) => ({
          tag,
          confidence: 0.8,
          reasoning: `Extracted by ${this.client.modelName}`,
        }));
    } catch {
      return [];
    }
  }
}
