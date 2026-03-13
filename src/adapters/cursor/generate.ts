import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterConfig, AdapterResult } from '../types.js';

const AEGIS_MARKER = '<!-- aegis:managed -->';
const RULE_FILENAME = 'aegis-process.mdc';
const DEFAULT_RULES_DIR = join('.cursor', 'rules');

function generateCursorRule(config: AdapterConfig): string {
  return `${AEGIS_MARKER}
---
description: Aegis process enforcement — always consult Aegis before writing code
globs:
alwaysApply: true
---

# Aegis Process Enforcement

You MUST follow this process for every coding task. No exceptions.

## Before Writing Code

1. **Create a Plan** — Before touching any file, articulate what you intend to do in natural language.
2. **Consult Aegis** — Call \`${config.toolNames.compileContext}\` with:
   - \`target_files\`: the files you plan to edit
   - \`plan\`: your natural-language plan (optional but recommended)
   - \`command\`: the type of operation (scaffold, refactor, review, etc.)
3. **Read the returned documents** — Aegis returns architecture guidelines, patterns, and constraints relevant to your task. You MUST follow them.
4. **Implement** — Write code that adheres to the returned guidelines.

## After Writing Code

5. **Self-Review** — Check your implementation against the guidelines Aegis returned.
6. **Report Violations** — If you discover that Aegis did not provide a relevant guideline (a "compile miss"), report it:
   \`\`\`
   ${config.toolNames.observe}({
     event_type: "compile_miss",
     related_compile_id: "<from step 2>",
     related_snapshot_id: "<from step 2>",
     payload: {
       target_files: ["<files you edited>"],
       review_comment: "<what guideline was missing or insufficient>",
       target_doc_id: "<optional: base.documents[*].doc_id whose content was insufficient>",
       missing_doc: "<optional: doc_id that should have been returned but was not>"
     }
   })
   \`\`\`
   - \`target_doc_id\`: A doc_id from the **base.documents** section of the compile result whose content was insufficient. Do NOT use expanded or template doc_ids.
   - \`missing_doc\`: A doc_id that should have been included in the compile result but was absent.
   - If neither can be identified, \`review_comment\` alone is sufficient.

## Rules

- NEVER skip the Aegis consultation step.
- NEVER ignore guidelines returned by Aegis.
- If Aegis returns no documents (empty base), proceed but note this may indicate missing DAG edges.
- The \`compile_id\` and \`snapshot_id\` from step 2 are required for any observation reporting.
`;
}

export function deployCursorAdapter(config: AdapterConfig, rulesRelDir?: string): AdapterResult {
  const rulesDir = join(config.projectRoot, rulesRelDir ?? DEFAULT_RULES_DIR);
  const filePath = join(rulesDir, RULE_FILENAME);

  mkdirSync(rulesDir, { recursive: true });

  const content = generateCursorRule(config);

  if (existsSync(filePath)) {
    const existing = readFileSync(filePath, 'utf-8');
    if (existing.startsWith(AEGIS_MARKER)) {
      writeFileSync(filePath, content, 'utf-8');
      return { filePath, status: 'updated', content };
    }
    return { filePath, status: 'conflict', content: existing };
  }

  writeFileSync(filePath, content, 'utf-8');
  return { filePath, status: 'created', content };
}
