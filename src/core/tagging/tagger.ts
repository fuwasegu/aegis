/**
 * IntentTagger Port
 *
 * Extracts intent tags from plan text against a set of candidate tags.
 * Per ADR-004 D-5, the tagger acts as a classifier over the provided candidates.
 */

import type { IntentTag } from '../types.js';

export interface IntentTagger {
  extractTags(plan: string, knownTags: string[]): Promise<IntentTag[]>;
}
