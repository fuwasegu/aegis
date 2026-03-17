import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deployClaudeAdapter } from './claude/generate.js';
import { deployCodexAdapter } from './codex/generate.js';
import { deployCursorAdapter } from './cursor/generate.js';
import { deploySkills, insertMarkerAfterFrontMatter, rewriteSkillLinks } from './skills.js';
import type { AdapterConfig } from './types.js';

function makeTmpDir(): string {
  const dir = join(import.meta.dirname, '..', '..', '.tmp-test', randomUUID());
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeConfig(projectRoot: string): AdapterConfig {
  return {
    projectRoot,
    templateId: 'test-template',
    toolNames: {
      compileContext: 'aegis_compile_context',
      observe: 'aegis_observe',
      getCompileAudit: 'aegis_get_compile_audit',
    },
  };
}

describe('Cursor adapter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const RULES_DIR = 'cursor-rules';

  it('creates rules dir and aegis-process.mdc', () => {
    const config = makeConfig(tmpDir);
    const result = deployCursorAdapter(config, RULES_DIR);

    expect(result.status).toBe('created');
    expect(result.filePath).toContain('aegis-process.mdc');
    expect(existsSync(result.filePath)).toBe(true);

    const content = readFileSync(result.filePath, 'utf-8');
    expect(content).toContain('aegis_compile_context');
    expect(content).toContain('aegis_observe');
    expect(content).toContain('Aegis Process Enforcement');
  });

  it('is idempotent — overwrites managed file', () => {
    const config = makeConfig(tmpDir);
    deployCursorAdapter(config, RULES_DIR);
    const result = deployCursorAdapter(config, RULES_DIR);

    expect(result.status).toBe('updated');
    expect(readFileSync(result.filePath, 'utf-8')).toContain('aegis_compile_context');
  });

  it('does not overwrite non-managed file (conflict)', () => {
    const config = makeConfig(tmpDir);
    const rulesDir = join(tmpDir, RULES_DIR);
    mkdirSync(rulesDir, { recursive: true });
    const filePath = join(rulesDir, 'aegis-process.mdc');
    writeFileSync(filePath, '# Custom rules\nDo not touch', 'utf-8');

    const result = deployCursorAdapter(config, RULES_DIR);
    expect(result.status).toBe('conflict');
    expect(readFileSync(filePath, 'utf-8')).toBe('# Custom rules\nDo not touch');
  });
});

describe('Claude adapter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates CLAUDE.md if not present', () => {
    const config = makeConfig(tmpDir);
    const result = deployClaudeAdapter(config);

    expect(result.status).toBe('created');
    const content = readFileSync(result.filePath, 'utf-8');
    expect(content).toContain('<!-- aegis:start -->');
    expect(content).toContain('<!-- aegis:end -->');
    expect(content).toContain('aegis_compile_context');
  });

  it('appends section to existing CLAUDE.md', () => {
    const config = makeConfig(tmpDir);
    const filePath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(filePath, '# My Project\n\nExisting content.', 'utf-8');

    const result = deployClaudeAdapter(config);
    expect(result.status).toBe('created');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('# My Project');
    expect(content).toContain('Existing content.');
    expect(content).toContain('<!-- aegis:start -->');
    expect(content).toContain('aegis_compile_context');
  });

  it('replaces existing aegis section (idempotent)', () => {
    const config = makeConfig(tmpDir);
    const filePath = join(tmpDir, 'CLAUDE.md');
    writeFileSync(filePath, '# Header\n\n<!-- aegis:start -->\nold content\n<!-- aegis:end -->\n\n# Footer', 'utf-8');

    const result = deployClaudeAdapter(config);
    expect(result.status).toBe('updated');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Header');
    expect(content).toContain('# Footer');
    expect(content).toContain('aegis_compile_context');
    expect(content).not.toContain('old content');
  });
});

describe('Codex adapter', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates AGENTS.md if not present', () => {
    const config = makeConfig(tmpDir);
    const result = deployCodexAdapter(config);

    expect(result.status).toBe('created');
    const content = readFileSync(result.filePath, 'utf-8');
    expect(content).toContain('<!-- aegis:start -->');
    expect(content).toContain('<!-- aegis:end -->');
    expect(content).toContain('aegis_compile_context');
    expect(content).toContain('AGENTS.md');
  });

  it('appends section to existing AGENTS.md', () => {
    const config = makeConfig(tmpDir);
    const filePath = join(tmpDir, 'AGENTS.md');
    writeFileSync(filePath, '# My Project Agents\n\nExisting instructions.', 'utf-8');

    const result = deployCodexAdapter(config);
    expect(result.status).toBe('created');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('# My Project Agents');
    expect(content).toContain('Existing instructions.');
    expect(content).toContain('<!-- aegis:start -->');
    expect(content).toContain('aegis_compile_context');
  });

  it('replaces existing aegis section (idempotent)', () => {
    const config = makeConfig(tmpDir);
    const filePath = join(tmpDir, 'AGENTS.md');
    writeFileSync(filePath, '# Header\n\n<!-- aegis:start -->\nold content\n<!-- aegis:end -->\n\n# Footer', 'utf-8');

    const result = deployCodexAdapter(config);
    expect(result.status).toBe('updated');

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Header');
    expect(content).toContain('# Footer');
    expect(content).toContain('aegis_compile_context');
    expect(content).not.toContain('old content');
  });
});

describe('Skills deployment (Agent Skills standard)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(['cursor', 'claude', 'codex'])('deploys skills for %s target', (target) => {
    const results = deploySkills(tmpDir, target);

    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const skill of results) {
      expect(skill.status).toBe('created');
      expect(existsSync(skill.filePath)).toBe(true);
      expect(readFileSync(skill.filePath, 'utf-8')).toContain('aegis');
    }
  });

  it('cursor skills go to .cursor/skills/', () => {
    const results = deploySkills(tmpDir, 'cursor');
    for (const r of results) {
      expect(r.filePath).toContain(join('.cursor', 'skills'));
    }
  });

  it('claude skills go to .claude/skills/', () => {
    const results = deploySkills(tmpDir, 'claude');
    for (const r of results) {
      expect(r.filePath).toContain(join('.claude', 'skills'));
    }
  });

  it('codex skills go to .codex/skills/', () => {
    const results = deploySkills(tmpDir, 'codex');
    for (const r of results) {
      expect(r.filePath).toContain(join('.codex', 'skills'));
    }
  });

  it('is idempotent — overwrites managed skills', () => {
    deploySkills(tmpDir, 'cursor');
    const results = deploySkills(tmpDir, 'cursor');

    for (const skill of results) {
      expect(['created', 'updated']).toContain(skill.status);
    }
  });

  it('does not overwrite non-managed skills (conflict)', () => {
    const skillDir = join(tmpDir, '.cursor', 'skills', 'aegis-setup');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# My custom skill', 'utf-8');

    const results = deploySkills(tmpDir, 'cursor');
    const setup = results.find((r) => r.filePath.includes('aegis-setup'));
    expect(setup?.status).toBe('conflict');
  });

  it('returns empty for unknown target', () => {
    const results = deploySkills(tmpDir, 'unknown-agent');
    expect(results).toHaveLength(0);
  });

  it('rewrites inter-skill links to deployed layout', () => {
    const results = deploySkills(tmpDir, 'cursor');
    const setup = results.find((r) => r.filePath.includes('aegis-setup'));
    if (setup) {
      const content = readFileSync(setup.filePath, 'utf-8');
      expect(content).not.toContain('(aegis-bulk-import.md)');
      expect(content).toContain('(../aegis-bulk-import/SKILL.md)');
    }
  });

  it('preserves YAML front matter at file start (marker inserted after)', () => {
    const results = deploySkills(tmpDir, 'cursor');
    for (const r of results) {
      const content = readFileSync(r.filePath, 'utf-8');
      if (content.includes('---')) {
        expect(content).toMatch(/^---\n/);
        const secondFence = content.indexOf('---', 3);
        expect(secondFence).toBeGreaterThan(0);
        const afterFrontMatter = content.slice(secondFence + 4);
        expect(afterFrontMatter).toContain('<!-- aegis:managed-skill -->');
      }
    }
  });
});

describe('rewriteSkillLinks', () => {
  it('rewrites flat .md links to deployed directory layout', () => {
    const input = 'see [bulk import](aegis-bulk-import.md) for details';
    expect(rewriteSkillLinks(input)).toBe('see [bulk import](../aegis-bulk-import/SKILL.md) for details');
  });

  it('preserves fragment identifiers', () => {
    const input = 'see [setup step 3](aegis-setup.md#step-3) for details';
    expect(rewriteSkillLinks(input)).toBe('see [setup step 3](../aegis-setup/SKILL.md#step-3) for details');
  });

  it('does not rewrite absolute or external URLs', () => {
    const input = 'see [docs](https://example.com/aegis-setup.md) or [local](/docs/aegis-setup.md)';
    expect(rewriteSkillLinks(input)).toBe(input);
  });

  it('rewrites multiple links in one string', () => {
    const input = '[a](aegis-setup.md) and [b](aegis-bulk-import.md)';
    expect(rewriteSkillLinks(input)).toBe('[a](../aegis-setup/SKILL.md) and [b](../aegis-bulk-import/SKILL.md)');
  });
});

describe('insertMarkerAfterFrontMatter', () => {
  it('inserts marker after LF front matter', () => {
    const source = '---\nname: test\n---\n# Content';
    const result = insertMarkerAfterFrontMatter(source);
    expect(result).toBe('---\nname: test\n---\n<!-- aegis:managed-skill -->\n# Content');
  });

  it('inserts marker after CRLF front matter', () => {
    const source = '---\r\nname: test\r\n---\r\n# Content';
    const result = insertMarkerAfterFrontMatter(source);
    expect(result).toBe('---\r\nname: test\r\n---\r\n<!-- aegis:managed-skill -->\n# Content');
  });

  it('inserts marker at start when no front matter', () => {
    const source = '# No front matter';
    const result = insertMarkerAfterFrontMatter(source);
    expect(result).toBe('<!-- aegis:managed-skill -->\n# No front matter');
  });
});
