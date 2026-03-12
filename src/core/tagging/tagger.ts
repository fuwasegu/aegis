/**
 * IntentTagger Port
 *
 * Extracts intent tags from plan text.
 * Implementations: FakeTagger (tests), SLM adapter (future).
 */

import type { IntentTag } from '../types.js';

export interface IntentTagger {
  extractTags(plan: string): Promise<IntentTag[]>;
}
