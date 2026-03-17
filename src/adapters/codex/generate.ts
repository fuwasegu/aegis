import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterConfig, AdapterResult } from '../types.js';

const AEGIS_START = '<!-- aegis:start -->';
const AEGIS_END = '<!-- aegis:end -->';

function generateCodexSection(config: AdapterConfig): string {
  return `${AEGIS_START}
## Aegis Process Enforcement

You MUST consult Aegis for every coding-related interaction — implementation tasks AND questions about architecture, patterns, or conventions. No exceptions.

### When Writing Code

1. **Create a Plan** — Before touching any file, articulate what you intend to do.
2. **Consult Aegis** — Call \`${config.toolNames.compileContext}\` with:
   - \`target_files\`: the files you plan to edit
   - \`plan\`: your natural-language plan (optional but recommended)
   - \`command\`: the type of operation (scaffold, refactor, review, etc.)
3. **Read and follow** the returned architecture guidelines.
4. **Self-Review** — After writing code, check your implementation against the returned guidelines.
5. **Report Compile Misses** — If Aegis failed to provide a needed guideline:
   \`\`\`
   ${config.toolNames.observe}({
     event_type: "compile_miss",
     related_compile_id: "<from step 2>",
     related_snapshot_id: "<from step 2>",
     payload: {
       target_files: ["<files>"],
       review_comment: "<what was missing or insufficient>",
       target_doc_id: "<optional: base.documents[*].doc_id whose content was insufficient>",
       missing_doc: "<optional: doc_id that should have been returned but was not>"
     }
   })
   \`\`\`
   - \`target_doc_id\`: A doc_id from the **base.documents** section of the compile result whose content was insufficient. Do NOT use expanded or template doc_ids.
   - \`missing_doc\`: A doc_id that should have been included in the compile result but was absent.
   - If neither can be identified, \`review_comment\` alone is sufficient.

### When Answering Questions

If the user asks about architecture, patterns, conventions, or how to write code — even without requesting implementation:

1. **Consult Aegis** — Call \`${config.toolNames.compileContext}\` with:
   - \`target_files\`: concrete file paths relevant to the question (e.g. \`src/Application/CreateOrderUseCase.php\`, not globs)
   - \`plan\`: the user's question in natural language
   - \`command\`: \`"review"\`
2. **Answer using Aegis context** — Base your answer on the guidelines returned by Aegis, supplemented by your own knowledge. Cite specific guidelines when relevant.

### Rules

- NEVER skip the Aegis consultation step — for both implementation and questions.
- NEVER ignore guidelines returned by Aegis.
- The compile_id and snapshot_id from the consultation are required for observation reporting.
${AEGIS_END}`;
}

export function deployCodexAdapter(config: AdapterConfig): AdapterResult {
  const filePath = join(config.projectRoot, 'AGENTS.md');
  const section = generateCodexSection(config);

  if (!existsSync(filePath)) {
    const content = `# AGENTS.md\n\n${section}\n`;
    writeFileSync(filePath, content, 'utf-8');
    return { filePath, status: 'created', content };
  }

  const existing = readFileSync(filePath, 'utf-8');

  const startIdx = existing.indexOf(AEGIS_START);
  const endIdx = existing.indexOf(AEGIS_END);

  if (startIdx !== -1 && endIdx !== -1) {
    const content = existing.slice(0, startIdx) + section + existing.slice(endIdx + AEGIS_END.length);
    writeFileSync(filePath, content, 'utf-8');
    return { filePath, status: 'updated', content };
  }

  const content = `${existing.trimEnd()}\n\n${section}\n`;
  writeFileSync(filePath, content, 'utf-8');
  return { filePath, status: 'created', content };
}
