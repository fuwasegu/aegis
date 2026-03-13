import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterConfig, AdapterResult } from '../types.js';

const AEGIS_START = '<!-- aegis:start -->';
const AEGIS_END = '<!-- aegis:end -->';

function generateCodexSection(config: AdapterConfig): string {
  return `${AEGIS_START}
## Aegis Process Enforcement

You MUST follow this process for every coding task. No exceptions.

### Before Writing Code

1. **Create a Plan** — Before touching any file, articulate what you intend to do.
2. **Consult Aegis** — Call \`${config.toolNames.compileContext}\` with:
   - \`target_files\`: the files you plan to edit
   - \`plan\`: your natural-language plan (optional but recommended)
   - \`command\`: the type of operation (scaffold, refactor, review, etc.)
3. **Read and follow** the returned architecture guidelines.

### After Writing Code

4. **Self-Review** — Check your implementation against the returned guidelines.
5. **Report Compile Misses** — If Aegis failed to provide a needed guideline:
   \`\`\`
   ${config.toolNames.observe}({
     event_type: "compile_miss",
     related_compile_id: "<from step 2>",
     related_snapshot_id: "<from step 2>",
     payload: {
       target_files: ["<files>"],
       review_comment: "<what was missing>"
     }
   })
   \`\`\`

### Rules

- NEVER skip the Aegis consultation step.
- NEVER ignore guidelines returned by Aegis.
- The compile_id and snapshot_id from step 2 are required for observation reporting.
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
