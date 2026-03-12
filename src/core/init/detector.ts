/**
 * Stack Detector
 * Implements §8.2 Stage 1 (detect): static filesystem scan, no LLM.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';
import type {
  DetectSignal, TemplateManifest, PlaceholderDef,
} from './template-loader.js';

// ── Detection result types (mirrors v2 §8.3) ──

export interface StackDetection {
  language: string;
  framework?: string;
  package_manager: string;
  detected_from: string;
}

export interface ProfileCandidate {
  profile_id: string;
  confidence: 'high' | 'medium' | 'low';
  score: number;
  match_reasons: string[];
  unmatched_signals: string[];
}

export interface DetectionEvidence {
  signal_type: DetectSignal['type'];
  path: string;
  matched_profile: string;
  detail?: string;
}

export interface InitWarning {
  severity: 'info' | 'warn' | 'block';
  message: string;
  suggestion?: string;
  related_signal?: string;
}

/**
 * Detect stack from project root (static scan only).
 */
export function detectStack(projectRoot: string): StackDetection {
  // Check manifest files in priority order
  if (existsSync(join(projectRoot, 'composer.json'))) {
    const raw = JSON.parse(readFileSync(join(projectRoot, 'composer.json'), 'utf-8'));
    const framework = raw?.require?.['laravel/framework'] ? 'laravel'
      : raw?.require?.['symfony/framework-bundle'] ? 'symfony'
      : undefined;
    return { language: 'php', framework, package_manager: 'composer', detected_from: 'composer.json' };
  }
  if (existsSync(join(projectRoot, 'package.json'))) {
    const raw = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf-8'));
    const deps = { ...raw?.dependencies, ...raw?.devDependencies };
    const framework = deps?.['next'] ? 'next.js'
      : deps?.['nuxt'] ? 'nuxt'
      : undefined;
    return { language: 'typescript', framework, package_manager: 'npm', detected_from: 'package.json' };
  }
  if (existsSync(join(projectRoot, 'pyproject.toml'))) {
    return { language: 'python', package_manager: 'pip', detected_from: 'pyproject.toml' };
  }
  if (existsSync(join(projectRoot, 'go.mod'))) {
    return { language: 'go', package_manager: 'go mod', detected_from: 'go.mod' };
  }

  return { language: 'unknown', package_manager: 'unknown', detected_from: 'none' };
}

/**
 * Evaluate a single detect signal against a project root.
 */
export function evaluateSignal(signal: DetectSignal, projectRoot: string): boolean {
  switch (signal.type) {
    case 'file_exists':
      return signal.path ? existsSync(join(projectRoot, signal.path)) : false;

    case 'dir_exists':
      return signal.path ? existsSync(join(projectRoot, signal.path)) &&
        statSync(join(projectRoot, signal.path)).isDirectory() : false;

    case 'package_dependency': {
      if (!signal.file || !signal.key || !signal.pattern) return false;
      const filePath = join(projectRoot, signal.file);
      if (!existsSync(filePath)) return false;
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
        const deps = raw?.[signal.key];
        if (!deps || typeof deps !== 'object') return false;
        return Object.keys(deps).some(k => k === signal.pattern || k.includes(signal.pattern!));
      } catch {
        return false;
      }
    }

    case 'dir_structure': {
      if (!signal.pattern) return false;
      return globDirExists(projectRoot, signal.pattern);
    }

    default:
      return false;
  }
}

/**
 * Check if any directory matching a glob pattern exists.
 */
function globDirExists(root: string, pattern: string): boolean {
  // Simple recursive check for common patterns like "app/Domain/*/Entities"
  const segments = pattern.split('/');
  return walkSegments(root, segments, 0);
}

function walkSegments(current: string, segments: string[], idx: number): boolean {
  if (!existsSync(current) || !statSync(current).isDirectory()) return false;
  if (idx >= segments.length) return true;

  const seg = segments[idx];
  if (seg === '*' || seg === '**') {
    // Try all subdirectories
    try {
      for (const entry of readdirSync(current)) {
        const child = join(current, entry);
        if (statSync(child).isDirectory()) {
          if (walkSegments(child, segments, idx + 1)) return true;
        }
      }
    } catch {
      // Permission error etc.
    }
    return false;
  }

  return walkSegments(join(current, seg), segments, idx + 1);
}

/**
 * Score a template manifest against a project root.
 * Returns null if required signals are not met.
 */
export function scoreProfile(
  manifest: TemplateManifest,
  projectRoot: string,
): { candidate: ProfileCandidate; evidence: DetectionEvidence[] } | null {
  const evidence: DetectionEvidence[] = [];
  const matchReasons: string[] = [];
  const unmatchedSignals: string[] = [];

  // Check required signals
  for (const signal of manifest.detect_signals.required) {
    const matched = evaluateSignal(signal, projectRoot);
    if (!matched) return null; // required signal failed — not a candidate
    const path = signal.path ?? signal.file ?? signal.pattern ?? '';
    evidence.push({
      signal_type: signal.type,
      path,
      matched_profile: manifest.template_id,
      detail: `Required: ${signal.type}`,
    });
    matchReasons.push(`${signal.type}: ${path}`);
  }

  // Score boosters
  let totalWeight = 0;
  for (const booster of manifest.detect_signals.boosters) {
    const matched = evaluateSignal(booster, projectRoot);
    const path = booster.path ?? booster.pattern ?? '';
    if (matched) {
      totalWeight += booster.weight;
      matchReasons.push(`${booster.type}: ${path} (+${booster.weight})`);
      evidence.push({
        signal_type: booster.type,
        path,
        matched_profile: manifest.template_id,
      });
    } else {
      unmatchedSignals.push(`${booster.type}: ${path}`);
    }
  }

  const thresholds = manifest.detect_signals.confidence_thresholds;
  const confidence: 'high' | 'medium' | 'low' =
    totalWeight >= thresholds.high ? 'high'
    : totalWeight >= thresholds.medium ? 'medium'
    : 'low';

  return {
    candidate: {
      profile_id: manifest.template_id,
      confidence,
      score: totalWeight,
      match_reasons: matchReasons,
      unmatched_signals: unmatchedSignals,
    },
    evidence,
  };
}

/**
 * Resolve placeholders for a template against a project root.
 */
export function resolvePlaceholders(
  manifest: TemplateManifest,
  projectRoot: string,
): { resolved: Record<string, string | null>; warnings: InitWarning[] } {
  const resolved: Record<string, string | null> = {};
  const warnings: InitWarning[] = [];

  for (const [name, def] of Object.entries(manifest.placeholders)) {
    let value: string | null = null;

    if (def.detect_strategy === 'first_match' && def.candidates) {
      const matches: string[] = [];
      for (const candidate of def.candidates) {
        if (existsSync(join(projectRoot, candidate))) {
          matches.push(candidate);
        }
      }

      if (matches.length === 0) {
        value = def.default;
        if (def.required && value === null) {
          warnings.push({
            severity: 'block',
            message: `Required placeholder '${name}' could not be resolved. None of [${def.candidates.join(', ')}] exist.`,
            suggestion: `Create one of the candidate directories or provide a value manually.`,
            related_signal: name,
          });
        }
      } else if (matches.length === 1) {
        value = matches[0];
      } else {
        // Ambiguity
        if (def.ambiguity_policy === 'first') {
          value = matches[0];
          warnings.push({
            severity: 'info',
            message: `Placeholder '${name}': multiple matches [${matches.join(', ')}], using first: '${value}'`,
            related_signal: name,
          });
        } else {
          // block
          warnings.push({
            severity: 'block',
            message: `Placeholder '${name}': multiple matches [${matches.join(', ')}], ambiguity_policy is 'block'.`,
            suggestion: 'Remove extra candidates or specify the value manually.',
            related_signal: name,
          });
          value = null;
        }
      }
    } else if (def.detect_strategy === 'composer_autoload') {
      value = resolveComposerAutoload(projectRoot, def.default);
    } else if (def.detect_strategy === 'package_json_field' && def.candidates) {
      value = resolvePackageJsonField(projectRoot, def.candidates, def.default);
    } else {
      value = def.default;
    }

    resolved[name] = value;
  }

  return { resolved, warnings };
}

function resolveComposerAutoload(projectRoot: string, fallback: string | null): string | null {
  try {
    const composerPath = join(projectRoot, 'composer.json');
    if (!existsSync(composerPath)) return fallback;

    const composer = JSON.parse(readFileSync(composerPath, 'utf-8'));
    const psr4 = composer?.autoload?.['psr-4'];
    if (!psr4 || typeof psr4 !== 'object') return fallback;

    const entries = Object.entries(psr4) as [string, string][];
    if (entries.length === 0) return fallback;

    // Return the first PSR-4 source directory (most common: "App\\" → "app/")
    return entries[0][1].replace(/\/$/, '') || fallback;
  } catch {
    return fallback;
  }
}

function resolvePackageJsonField(
  projectRoot: string,
  fieldPaths: string[],
  fallback: string | null,
): string | null {
  try {
    const pkgPath = join(projectRoot, 'package.json');
    if (!existsSync(pkgPath)) return fallback;

    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

    for (const fieldPath of fieldPaths) {
      const value = getNestedField(pkg, fieldPath);
      if (typeof value === 'string' && value) return value;
    }

    return fallback;
  } catch {
    return fallback;
  }
}

function getNestedField(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
