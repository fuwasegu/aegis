import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { AdapterResult } from './types.js';

const SKILL_MARKER = '<!-- aegis:managed-skill -->';

/**
 * Skills directory per agent (Agent Skills open standard).
 * https://agentskills.io
 */
const SKILLS_DIR: Record<string, string> = {
  cursor: '.cursor/skills',
  claude: '.claude/skills',
  codex: '.codex/skills',
};

export function getSkillsDir(target: string): string | undefined {
  return SKILLS_DIR[target];
}

export function insertMarkerAfterFrontMatter(source: string): string {
  const fmRegex = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
  const match = source.match(fmRegex);
  if (match) {
    return `${match[0]}${SKILL_MARKER}\n${source.slice(match[0].length)}`;
  }
  return `${SKILL_MARKER}\n${source}`;
}

export function deploySkills(projectRoot: string, target: string): AdapterResult[] {
  const skillsRelDir = SKILLS_DIR[target];
  if (!skillsRelDir) return [];

  const bundledSkillsDir = join(import.meta.dirname, '../../skills');
  if (!existsSync(bundledSkillsDir)) return [];

  const results: AdapterResult[] = [];
  const files = readdirSync(bundledSkillsDir).filter((f) => f.endsWith('.md'));

  for (const file of files) {
    const skillName = basename(file, '.md');
    const targetDir = join(projectRoot, skillsRelDir, skillName);
    const targetPath = join(targetDir, 'SKILL.md');
    const source = readFileSync(join(bundledSkillsDir, file), 'utf-8');
    const content = source.includes(SKILL_MARKER) ? source : insertMarkerAfterFrontMatter(source);

    mkdirSync(targetDir, { recursive: true });

    if (existsSync(targetPath)) {
      const existing = readFileSync(targetPath, 'utf-8');
      if (existing.includes(SKILL_MARKER)) {
        writeFileSync(targetPath, content, 'utf-8');
        results.push({ filePath: targetPath, status: 'updated', content });
      } else {
        results.push({ filePath: targetPath, status: 'conflict', content: existing });
      }
    } else {
      writeFileSync(targetPath, content, 'utf-8');
      results.push({ filePath: targetPath, status: 'created', content });
    }
  }
  return results;
}
