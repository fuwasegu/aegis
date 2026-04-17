import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectStack, evaluateSignal, resolvePlaceholders, scoreProfile } from './detector.js';
import type { TemplateManifest } from './template-loader.js';

function rmDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe('detectStack', () => {
  let root: string;

  afterEach(() => {
    if (root) rmDir(root);
  });

  it('detects PHP + Laravel from composer.json', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    writeFileSync(join(root, 'composer.json'), JSON.stringify({ require: { 'laravel/framework': '^10.0' } }));
    expect(detectStack(root)).toEqual({
      language: 'php',
      framework: 'laravel',
      package_manager: 'composer',
      detected_from: 'composer.json',
    });
  });

  it('detects PHP + Symfony when Laravel is absent', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    writeFileSync(join(root, 'composer.json'), JSON.stringify({ require: { 'symfony/framework-bundle': '^6.0' } }));
    expect(detectStack(root)).toMatchObject({
      language: 'php',
      framework: 'symfony',
      package_manager: 'composer',
    });
  });

  it('detects PHP without framework when no known framework dep', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    writeFileSync(join(root, 'composer.json'), JSON.stringify({ require: { php: '^8.2' } }));
    expect(detectStack(root)).toEqual({
      language: 'php',
      framework: undefined,
      package_manager: 'composer',
      detected_from: 'composer.json',
    });
  });

  it('prefers composer.json over package.json when both exist', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    writeFileSync(join(root, 'composer.json'), JSON.stringify({ require: {} }));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '14' } }));
    expect(detectStack(root).language).toBe('php');
  });

  it('detects TypeScript + Next.js from package.json', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '14.0.0' } }));
    expect(detectStack(root)).toEqual({
      language: 'typescript',
      framework: 'next.js',
      package_manager: 'npm',
      detected_from: 'package.json',
    });
  });

  it('detects TypeScript + Nuxt when Next is absent', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ devDependencies: { nuxt: '3.0.0' } }));
    expect(detectStack(root)).toMatchObject({
      language: 'typescript',
      framework: 'nuxt',
    });
  });

  it('detects TypeScript without framework when package.json has no Next/Nuxt', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { lodash: '4.17.21' }, devDependencies: { typescript: '5.0.0' } }),
    );
    expect(detectStack(root)).toEqual({
      language: 'typescript',
      framework: undefined,
      package_manager: 'npm',
      detected_from: 'package.json',
    });
  });

  it('detects Python from pyproject.toml', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname = "x"\n');
    expect(detectStack(root)).toEqual({
      language: 'python',
      package_manager: 'pip',
      detected_from: 'pyproject.toml',
    });
  });

  it('detects Go from go.mod', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    writeFileSync(join(root, 'go.mod'), 'module example.com/foo\n');
    expect(detectStack(root)).toEqual({
      language: 'go',
      package_manager: 'go mod',
      detected_from: 'go.mod',
    });
  });

  it('returns unknown when no manifest is recognized', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    expect(detectStack(root)).toEqual({
      language: 'unknown',
      package_manager: 'unknown',
      detected_from: 'none',
    });
  });

  it('throws when composer.json is not valid JSON', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    writeFileSync(join(root, 'composer.json'), '{ not json');
    expect(() => detectStack(root)).toThrow();
  });

  it('throws when package.json is not valid JSON (no composer.json)', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    writeFileSync(join(root, 'package.json'), '{ not json');
    expect(() => detectStack(root)).toThrow();
  });
});

describe('evaluateSignal', () => {
  let root: string;

  afterEach(() => {
    if (root) rmDir(root);
  });

  it('file_exists: true when file is present', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    writeFileSync(join(root, 'a.txt'), 'x');
    expect(evaluateSignal({ type: 'file_exists', path: 'a.txt' }, root)).toBe(true);
  });

  it('file_exists: false when path missing', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    expect(evaluateSignal({ type: 'file_exists', path: 'nope' }, root)).toBe(false);
  });

  it('dir_exists: true only for directories', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    mkdirSync(join(root, 'd'));
    writeFileSync(join(root, 'f'), 'x');
    expect(evaluateSignal({ type: 'dir_exists', path: 'd' }, root)).toBe(true);
    expect(evaluateSignal({ type: 'dir_exists', path: 'f' }, root)).toBe(false);
  });

  it('package_dependency: matches dependency key', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { vitest: '1.0.0' } }));
    expect(
      evaluateSignal(
        { type: 'package_dependency', file: 'package.json', key: 'dependencies', pattern: 'vitest' },
        root,
      ),
    ).toBe(true);
  });

  it('package_dependency: false when JSON is invalid', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    writeFileSync(join(root, 'package.json'), '{');
    expect(
      evaluateSignal({ type: 'package_dependency', file: 'package.json', key: 'dependencies', pattern: 'x' }, root),
    ).toBe(false);
  });

  it('package_dependency: false when key is missing or not an object', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(
      evaluateSignal({ type: 'package_dependency', file: 'package.json', key: 'dependencies', pattern: 'x' }, root),
    ).toBe(false);
  });

  it('dir_structure: matches wildcard path segments', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    mkdirSync(join(root, 'app', 'Domain', 'Foo', 'Entities'), { recursive: true });
    expect(evaluateSignal({ type: 'dir_structure', pattern: 'app/Domain/*/Entities' }, root)).toBe(true);
  });

  it('dir_structure: false when pattern cannot be satisfied', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    mkdirSync(join(root, 'app'), { recursive: true });
    expect(evaluateSignal({ type: 'dir_structure', pattern: 'app/missing/leaf' }, root)).toBe(false);
  });
});

describe('scoreProfile', () => {
  let root: string;

  afterEach(() => {
    if (root) rmDir(root);
  });

  const baseManifest = (): TemplateManifest => ({
    template_id: 't1',
    version: '1.0.0',
    display_name: 't',
    description: 'd',
    detect_signals: {
      required: [{ type: 'file_exists', path: 'marker.txt' }],
      boosters: [
        { type: 'dir_exists', path: 'src', weight: 50 },
        { type: 'dir_exists', path: 'optional', weight: 10 },
      ],
      confidence_thresholds: { high: 50, medium: 10 },
    },
    placeholders: {},
    seed_documents: [],
    seed_edges: [],
    seed_layer_rules: [],
  });

  it('returns null when a required signal fails', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    expect(scoreProfile(baseManifest(), root)).toBeNull();
  });

  it('scores boosters and sets confidence from thresholds', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    writeFileSync(join(root, 'marker.txt'), 'm');
    mkdirSync(join(root, 'src'));
    const m = baseManifest();
    const result = scoreProfile(m, root);
    expect(result).not.toBeNull();
    expect(result!.candidate.confidence).toBe('high');
    expect(result!.candidate.score).toBe(50);
    expect(result!.candidate.unmatched_signals.some((s) => s.includes('optional'))).toBe(true);
  });
});

describe('resolvePlaceholders', () => {
  let root: string;

  afterEach(() => {
    if (root) rmDir(root);
  });

  it('first_match: resolves single candidate', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    mkdirSync(join(root, 'src'));
    const manifest: TemplateManifest = {
      template_id: 't',
      version: '1.0.0',
      display_name: 't',
      description: 'd',
      detect_signals: { required: [], boosters: [], confidence_thresholds: { high: 1, medium: 0 } },
      placeholders: {
        src_root: {
          description: 'src',
          required: true,
          detect_strategy: 'first_match',
          candidates: ['src'],
          ambiguity_policy: 'first',
          default: null,
        },
      },
      seed_documents: [],
      seed_edges: [],
      seed_layer_rules: [],
    };
    const { resolved, warnings } = resolvePlaceholders(manifest, root);
    expect(resolved.src_root).toBe('src');
    expect(warnings).toHaveLength(0);
  });

  it('first_match: block ambiguity yields block warning and null value', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    mkdirSync(join(root, 'a'));
    mkdirSync(join(root, 'b'));
    const manifest: TemplateManifest = {
      template_id: 't',
      version: '1.0.0',
      display_name: 't',
      description: 'd',
      detect_signals: { required: [], boosters: [], confidence_thresholds: { high: 1, medium: 0 } },
      placeholders: {
        p: {
          description: 'p',
          required: true,
          detect_strategy: 'first_match',
          candidates: ['a', 'b'],
          ambiguity_policy: 'block',
          default: null,
        },
      },
      seed_documents: [],
      seed_edges: [],
      seed_layer_rules: [],
    };
    const { resolved, warnings } = resolvePlaceholders(manifest, root);
    expect(resolved.p).toBeNull();
    expect(warnings.some((w) => w.severity === 'block')).toBe(true);
  });

  it('composer_autoload: reads first PSR-4 path', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    writeFileSync(
      join(root, 'composer.json'),
      JSON.stringify({
        autoload: { 'psr-4': { 'App\\': 'app/', 'X\\': 'lib/' } },
      }),
    );
    const manifest: TemplateManifest = {
      template_id: 't',
      version: '1.0.0',
      display_name: 't',
      description: 'd',
      detect_signals: { required: [], boosters: [], confidence_thresholds: { high: 1, medium: 0 } },
      placeholders: {
        ns: {
          description: 'n',
          required: false,
          detect_strategy: 'composer_autoload',
          ambiguity_policy: 'first',
          default: 'fallback',
        },
      },
      seed_documents: [],
      seed_edges: [],
      seed_layer_rules: [],
    };
    const { resolved } = resolvePlaceholders(manifest, root);
    expect(resolved.ns).toBe('app');
  });

  it('package_json_field: reads nested string field', () => {
    root = mkdtempSync(join(tmpdir(), 'aegis-det-'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pkg', config: { custom: 'value' } }));
    const manifest: TemplateManifest = {
      template_id: 't',
      version: '1.0.0',
      display_name: 't',
      description: 'd',
      detect_signals: { required: [], boosters: [], confidence_thresholds: { high: 1, medium: 0 } },
      placeholders: {
        extra: {
          description: 'e',
          required: false,
          detect_strategy: 'package_json_field',
          candidates: ['config.custom', 'name'],
          ambiguity_policy: 'first',
          default: null,
        },
      },
      seed_documents: [],
      seed_edges: [],
      seed_layer_rules: [],
    };
    const { resolved } = resolvePlaceholders(manifest, root);
    expect(resolved.extra).toBe('value');
  });
});
