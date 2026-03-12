import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { deployCursorAdapter } from './cursor/generate.js';
import { deployClaudeAdapter } from './claude/generate.js';
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

    expect(result.created).toBe(true);
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

    expect(result.created).toBe(false);
    expect(readFileSync(result.filePath, 'utf-8')).toContain('aegis_compile_context');
  });

  it('does not overwrite non-managed file', () => {
    const config = makeConfig(tmpDir);
    const rulesDir = join(tmpDir, RULES_DIR);
    mkdirSync(rulesDir, { recursive: true });
    const filePath = join(rulesDir, 'aegis-process.mdc');
    writeFileSync(filePath, '# Custom rules\nDo not touch', 'utf-8');

    const result = deployCursorAdapter(config, RULES_DIR);
    expect(result.created).toBe(false);
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

    expect(result.created).toBe(true);
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
    expect(result.created).toBe(false);

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
    expect(result.created).toBe(false);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('# Header');
    expect(content).toContain('# Footer');
    expect(content).toContain('aegis_compile_context');
    expect(content).not.toContain('old content');
  });
});
