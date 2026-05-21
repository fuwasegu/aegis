#!/usr/bin/env node

/**
 * Aegis MCP Server Entry Point
 *
 * MCP server mode:
 *   npx aegis --surface agent                    # Agent surface (default)
 *   npx aegis --surface admin                    # Admin surface
 *   npx aegis --slm                              # Enable SLM for expanded context (opt-in)
 *   npx aegis --slm --model qwen3.5-9b           # Select SLM model from catalog
 *   npx aegis --slm --model hf:user/repo:f.gguf  # Custom HuggingFace model
 *   npx aegis --slm --ollama                      # Use Ollama instead of llama.cpp
 *
 * CLI subcommands:
 *   npx aegis deploy-adapters                    # Deploy all IDE adapters
 *   npx aegis deploy-adapters --targets cursor,codex
 *   npx aegis deploy-adapters --project-root /path/to/project
 *   npx aegis deploy-adapters --db path/to/aegis.db  # Use custom DB path
 *   npx aegis maintenance                        # process_observations → sync_docs → archive → check_upgrade
 *   npx aegis maintenance --dry-run                # Report only (no writes)
 *   npx aegis stats                              # JSON: knowledge / usage / health (read-only; no DB writes)
 *   npx aegis doctor                             # Health summary; read-only; exits 1 if issues
 *   npx aegis share-export                       # Export approved Canonical to aegis-share/
 *   npx aegis share-export --out /path/to/dir    # Custom output directory
 *   npx aegis share-hydrate                      # Rebuild replica DB from aegis-share/
 *   npx aegis share-hydrate --replace            # Overwrite existing initialized DB
 *   npx aegis share-hydrate --bundle-dir /path   # Custom bundle directory
 *   npx aegis share-lint                         # Lint aegis-share/source/
 *   npx aegis share-lint --source-dir /path      # Custom source directory
 *   npx aegis share-format                       # Format aegis-share/source/ in-place
 *   npx aegis share-format --source-dir /path    # Custom source directory
 *   npx aegis share-materialize                  # Materialize aegis-share/source/ into DB
 *   npx aegis share-materialize --dry-run        # Show diff summary without applying
 *   npx aegis share-materialize --source-dir /p  # Custom source directory
 *   npx aegis share-source-export                # Export DB to aegis-share/source/
 *   npx aegis share-source-export --out /path    # Custom output directory
 *   npx aegis --list-models                      # List available SLM models
 *
 * SLM is disabled by default (ADR-004). Enable with --slm for expanded context.
 * Models are stored in ~/.aegis/models/ (shared across projects).
 * DB defaults to .aegis/aegis.db (per project).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory of this module (`import.meta.dirname` is Node 20.11+; CI tests Node 18). */
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { shareHydrate } from './core/project-share/hydrate.js';
import {
  shareExport,
  shareFormat,
  shareLint,
  shareMaterialize,
  shareSourceExport,
} from './core/project-share/index.js';
import { createDatabase } from './core/store/database.js';
import { runInitialBaselineSourcePathMigration } from './core/store/migrations/index.js';
import { Repository } from './core/store/repository.js';
import type { IntentTagger } from './core/tagging/tagger.js';
import { OllamaIntentTagger } from './expansion/intent-tagger.js';
import { LlamaEngine } from './expansion/llama-engine.js';
import { LlamaIntentTagger } from './expansion/llama-intent-tagger.js';
import { DEFAULT_MODEL, MODEL_CATALOG } from './expansion/models.js';
import { OllamaClient } from './expansion/ollama-client.js';
import { createAegisServer } from './mcp/server.js';
import type { Surface } from './mcp/services.js';
import { AegisService, type MaintenanceRunResult } from './mcp/services.js';

interface StatsDoctorCli {
  projectRoot: string;
  customDbPath: string | undefined;
  templatesRoot: string;
  extraTemplateDirs: string[];
}

function parseStatsDoctorCli(argv: string[]): StatsDoctorCli {
  let projectRoot = process.cwd();
  let customDbPath: string | undefined;
  let templatesRoot = join(SCRIPT_DIR, '../templates');
  const extraTemplateDirs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--project-root':
        projectRoot = resolve(argv[++i]);
        break;
      case '--db':
        customDbPath = argv[++i];
        break;
      case '--templates':
        templatesRoot = argv[++i];
        break;
      case '--template-dir':
        extraTemplateDirs.push(argv[++i]);
        break;
    }
  }
  return { projectRoot, customDbPath, templatesRoot, extraTemplateDirs };
}

async function openServiceForStatsDoctor(options: StatsDoctorCli): Promise<AegisService> {
  const dbPath = options.customDbPath ?? join(options.projectRoot, DEFAULT_DB_PATH);
  if (!existsSync(dbPath)) {
    console.error(`[aegis] Database not found at ${dbPath}`);
    console.error('[aegis] Run aegis init first, or specify --project-root / --db.');
    process.exit(1);
  }
  const db = await createDatabase(dbPath);
  const repo = new Repository(db);
  // Intentionally no runInitialBaselineSourcePathMigration: stats/doctor are read-only monitoring
  // commands (writable DB dirs, read-only mounts). ADR-013 baseline runs on `aegis --surface admin`
  // and maintenance; until then stale-file signals may reflect legacy absolute source_path rows.
  return new AegisService(repo, options.templatesRoot, null, options.extraTemplateDirs, false, options.projectRoot);
}

const PACKAGE_VERSION: string = JSON.parse(readFileSync(join(SCRIPT_DIR, '../package.json'), 'utf-8')).version;

const DEFAULT_DB_DIR = '.aegis';
const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, 'aegis.db');

interface CliArgs {
  surface: Surface;
  dbPath: string;
  templatesRoot: string;
  extraTemplateDirs: string[];
  projectRoot: string;
  model: string;
  enableSlm: boolean;
  useOllama: boolean;
  ollamaUrl: string;
  listModels: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let surface: Surface = 'agent';
  let dbPath: string | undefined;
  let templatesRoot = join(SCRIPT_DIR, '../templates');
  const extraTemplateDirs: string[] = [];
  let projectRoot = process.cwd();
  let model = DEFAULT_MODEL;
  let enableSlm = false;
  let useOllama = false;
  let ollamaUrl = 'http://localhost:11434';
  let listModels = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--surface':
        surface = args[++i] as Surface;
        if (surface !== 'agent' && surface !== 'admin') {
          console.error(`Invalid surface: ${surface}. Must be 'agent' or 'admin'.`);
          process.exit(1);
        }
        break;
      case '--db':
        dbPath = args[++i];
        break;
      case '--templates':
        templatesRoot = args[++i];
        break;
      case '--project-root':
        projectRoot = resolve(args[++i]);
        break;
      case '--model':
        model = args[++i];
        break;
      case '--template-dir':
        extraTemplateDirs.push(args[++i]);
        break;
      case '--slm':
        enableSlm = true;
        break;
      case '--no-slm':
      case '--no-ollama':
        enableSlm = false;
        break;
      case '--ollama':
        useOllama = true;
        enableSlm = true;
        break;
      case '--ollama-url':
        ollamaUrl = args[++i];
        break;
      case '--ollama-model':
        model = args[++i];
        enableSlm = true;
        break;
      case '--list-models':
        listModels = true;
        break;
    }
  }

  // Default DB path is relative to projectRoot (not cwd)
  const resolvedDbPath = dbPath ?? join(projectRoot, DEFAULT_DB_PATH);

  return {
    surface,
    dbPath: resolvedDbPath,
    templatesRoot,
    extraTemplateDirs,
    projectRoot,
    model,
    enableSlm,
    useOllama,
    ollamaUrl,
    listModels,
  };
}

async function createTagger(cliArgs: CliArgs): Promise<IntentTagger | null> {
  if (!cliArgs.enableSlm) return null;

  if (cliArgs.useOllama) {
    return createOllamaTagger(cliArgs);
  }

  return createLlamaTagger(cliArgs);
}

async function createLlamaTagger(cliArgs: CliArgs): Promise<IntentTagger | null> {
  try {
    const engine = new LlamaEngine({ model: cliArgs.model });
    console.error(`[aegis] Initializing llama.cpp engine (model: ${cliArgs.model})...`);
    await engine.initialize();
    console.error(`[aegis] llama.cpp engine ready`);
    return new LlamaIntentTagger(engine);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[aegis] llama.cpp initialization failed: ${message}`);
    if (message.includes('node-llama-cpp is not installed')) {
      console.error('[aegis] SLM requested but node-llama-cpp is not available.');
      console.error('[aegis] Install it with: npm install node-llama-cpp');
    }
    console.error('[aegis] Expanded context disabled, continuing with base DAG context only.');
    return null;
  }
}

async function createOllamaTagger(cliArgs: CliArgs): Promise<IntentTagger | null> {
  const client = new OllamaClient({
    baseUrl: cliArgs.ollamaUrl,
    model: cliArgs.model,
  });

  const healthy = await client.isHealthy();
  if (!healthy) {
    console.error(`[aegis] Ollama not reachable at ${cliArgs.ollamaUrl} — expanded context disabled`);
    return null;
  }

  console.error(`[aegis] Ollama connected (model: ${cliArgs.model})`);
  return new OllamaIntentTagger(client);
}

function printModels(): void {
  console.error('\nAvailable models:\n');
  for (const [name, entry] of Object.entries(MODEL_CATALOG)) {
    const defaultMark = name === DEFAULT_MODEL ? ' (default)' : '';
    console.error(`  ${name}${defaultMark}`);
    console.error(`    ${entry.description}`);
    console.error(`    Size: ${entry.sizeHint}\n`);
  }
  console.error('You can also pass a HuggingFace URI directly:');
  console.error('  --model hf:user/repo:filename.gguf\n');
}

async function handleDeployAdapters(): Promise<void> {
  const args = process.argv.slice(3);
  let projectRoot = process.cwd();
  let targets: string[] | undefined;
  let customDbPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--project-root':
        projectRoot = resolve(args[++i]);
        break;
      case '--targets':
        targets = args[++i].split(',').map((t) => t.trim());
        break;
      case '--db':
        customDbPath = args[++i];
        break;
    }
  }

  const dbPath = customDbPath ?? join(projectRoot, DEFAULT_DB_PATH);
  if (!existsSync(dbPath)) {
    console.error(`[aegis] Database not found at ${dbPath}`);
    console.error('[aegis] Run aegis init first, or specify --project-root / --db.');
    process.exit(1);
  }

  const db = await createDatabase(dbPath);
  const repo = new Repository(db);
  const templatesRoot = join(SCRIPT_DIR, '../templates');
  const service = new AegisService(repo, templatesRoot, null);
  const results = service.deployAdapters(projectRoot, targets);

  const isFullDeploy = !targets;
  const hasFailure = results.some((r) => r.status === 'failed' || r.status === 'conflict');
  if (isFullDeploy && !hasFailure) {
    repo.upsertAdapterMeta(PACKAGE_VERSION);
  }

  const statusIcon: Record<string, string> = {
    created: '+',
    updated: '~',
    unchanged: '=',
    skipped: '-',
    conflict: '!',
    failed: 'x',
  };

  console.log('\nAdapter deployment results:\n');
  for (const r of results) {
    console.log(`  [${statusIcon[r.status] ?? '?'}] ${r.status.padEnd(10)} ${r.filePath}`);
  }
  console.log('');
}

function printMaintenanceSummary(result: MaintenanceRunResult): void {
  const mode = result.dry_run ? '(dry-run)' : '';
  console.log(`\nAegis maintenance ${mode}\n`);

  console.log('1. process_observations');
  const po = result.process_observations;
  if (result.dry_run) {
    console.log(`   pending_total: ${po.pending_total}`);
    for (const [et, n] of Object.entries(po.pending_by_type)) {
      console.log(`   - ${et}: ${n}`);
    }
  } else {
    console.log(`   processed (observations): ${po.processed ?? 0}`);
    console.log(`   proposals_created: ${po.proposals_created ?? 0}`);
    if (po.errors?.length) {
      console.log(`   errors:`);
      for (const e of po.errors) {
        console.log(`     - ${e}`);
      }
    }
  }

  console.log('\n2. sync_docs');
  const sd = result.sync_docs;
  console.log(`   checked: ${sd.checked}, up_to_date: ${sd.up_to_date}`);
  if (sd.dry_run && sd.would_create_proposals?.length) {
    console.log(
      `   would_create_proposals (${sd.would_create_proposals.length}): ${sd.would_create_proposals.join(', ')}`,
    );
  } else {
    console.log(`   proposals_created: ${sd.proposals_created.length}`);
    if (sd.proposals_created.length) {
      console.log(`     ${sd.proposals_created.join(', ')}`);
    }
  }
  if (sd.skipped_pending.length) {
    console.log(`   skipped_pending: ${sd.skipped_pending.join(', ')}`);
  }
  if (sd.not_found.length) {
    console.log(`   not_found: ${sd.not_found.join(', ')}`);
  }
  if (sd.skipped_invalid_anchor.length) {
    console.log(`   skipped_invalid_anchor: ${sd.skipped_invalid_anchor.join(', ')}`);
  }

  const st = result.staleness_report;
  console.log(
    `\n   staleness (file-anchored, >= ${st.threshold_days}d since source sync): ${st.stale_file_anchored_doc_ids.length} doc(s)`,
  );
  if (st.stale_file_anchored_doc_ids.length) {
    console.log(`     ${st.stale_file_anchored_doc_ids.join(', ')}`);
  }

  if (st.semantic) {
    console.log(
      `\n   semantic staleness (${st.semantic.algorithm_version}): ${st.semantic.findings.length} finding(s), ${st.semantic.baseline_writes} baseline write(s)`,
    );
    if (st.semantic.findings.length > 0) {
      for (const f of st.semantic.findings) {
        console.log(`     [L${String(f.level)}/${f.kind}] ${f.doc_id}: ${f.detail}`);
      }
    }
  }

  console.log('\n3. archive_observations');
  const ar = result.archive_observations;
  console.log(`   eligible (older than threshold, no pending block): ${ar.eligible_count}`);
  if (!result.dry_run && ar.archived_count !== undefined) {
    console.log(`   archived: ${ar.archived_count}`);
  }

  console.log('\n4. check_upgrade');
  const cu = result.check_upgrade;
  if (!cu) {
    console.log('   (no init manifest or no template)');
  } else if ('not_found' in cu && cu.not_found) {
    console.log(`   no upgrade preview (template_id: ${cu.template_id})`);
  } else if ('has_changes' in cu) {
    console.log(`   has_changes: ${cu.has_changes}, template_id: ${cu.template_id}`);
  } else {
    console.log('   (unexpected check_upgrade shape)');
  }

  console.log('\n5. co_change_cache');
  const cc = result.co_change_cache;
  if (!cc.git_available) {
    console.log(`   skipped (${cc.skipped_reason ?? 'unavailable'})`);
  } else {
    console.log(`   commits_scanned: ${cc.commits_scanned}`);
    console.log(`   pattern_rows: ${cc.pattern_rows}`);
    console.log(`   full_scan: ${cc.full_scan}`);
    if (cc.skipped_reason) {
      console.log(`   note: ${cc.skipped_reason}`);
    }
  }

  console.log('');
}

async function handleMaintenance(): Promise<void> {
  const args = process.argv.slice(3);
  let projectRoot = process.cwd();
  let dryRun = false;
  let archiveDays = 90;
  let customDbPath: string | undefined;
  let templatesRoot = join(SCRIPT_DIR, '../templates');
  const extraTemplateDirs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run':
        dryRun = true;
        break;
      case '--days':
        archiveDays = parseInt(args[++i], 10);
        if (Number.isNaN(archiveDays) || archiveDays < 1) {
          console.error('[aegis] --days must be a positive integer');
          process.exit(1);
        }
        break;
      case '--project-root':
        projectRoot = resolve(args[++i]);
        break;
      case '--db':
        customDbPath = args[++i];
        break;
      case '--templates':
        templatesRoot = args[++i];
        break;
      case '--template-dir':
        extraTemplateDirs.push(args[++i]);
        break;
    }
  }

  const dbPath = customDbPath ?? join(projectRoot, DEFAULT_DB_PATH);
  if (!existsSync(dbPath)) {
    console.error(`[aegis] Database not found at ${dbPath}`);
    console.error('[aegis] Run aegis init first, or specify --project-root / --db.');
    process.exit(1);
  }

  const db = await createDatabase(dbPath);
  const repo = new Repository(db);
  // Dry-run must not mutate Canonical; skip ADR-013 source_path baseline (same as avoiding writes in runMaintenance).
  if (repo.isInitialized() && !dryRun) {
    runInitialBaselineSourcePathMigration(repo, projectRoot);
  }

  const service = new AegisService(repo, templatesRoot, null, extraTemplateDirs, false, projectRoot);
  const result = await service.runMaintenance('admin', { dryRun, archiveDays });
  printMaintenanceSummary(result);
  if (!dryRun && result.process_observations.errors?.length) {
    process.exit(1);
  }
}

async function handleStats(): Promise<void> {
  const opts = parseStatsDoctorCli(process.argv.slice(3));
  const service = await openServiceForStatsDoctor(opts);
  const stats = service.getStats('admin');
  console.log(JSON.stringify(stats, null, 2));
}

async function handleDoctor(): Promise<void> {
  const opts = parseStatsDoctorCli(process.argv.slice(3));
  const service = await openServiceForStatsDoctor(opts);
  const stats = service.getStats('admin');
  const h = stats.health;
  const issues: string[] = [];
  if (h.stale_docs_count > 0) issues.push(`${h.stale_docs_count} stale file-anchored doc(s)`);
  if (h.unanalyzed_observations > 0) issues.push(`${h.unanalyzed_observations} unanalyzed observation(s)`);
  if (h.orphaned_tag_mappings > 0) issues.push(`${h.orphaned_tag_mappings} orphaned tag mapping(s)`);

  console.log('\nAegis doctor\n');
  console.log(`  knowledge_version: ${stats.knowledge.knowledge_version}`);
  console.log(`  stale_docs: ${h.stale_docs_count}`);
  if (h.stale_file_anchored_doc_ids.length) {
    console.log(`    ${h.stale_file_anchored_doc_ids.join(', ')}`);
  }
  console.log(`  unanalyzed_observations: ${h.unanalyzed_observations}`);
  for (const [et, n] of Object.entries(h.unanalyzed_by_event_type)) {
    if (n > 0) console.log(`    - ${et}: ${n}`);
  }
  console.log(`  orphaned_tag_mappings: ${h.orphaned_tag_mappings}`);
  if (h.orphaned_tag_mapping_samples.length) {
    for (const s of h.orphaned_tag_mapping_samples) {
      console.log(`    - ${s.tag} -> ${s.doc_id}`);
    }
  }

  // ADR-017: project-share status
  if (stats.project_share) {
    const ps = stats.project_share;
    console.log(`  project_share: ${ps.state}`);
    if (ps.state !== 'not_configured') {
      console.log(`    ${ps.message}`);
      if (ps.state === 'bundle_newer' || ps.state === 'local_ahead' || ps.state === 'diverged') {
        issues.push(`project-share ${ps.state}`);
      }
      if (ps.state === 'unreadable_bundle') {
        issues.push('project-share bundle unreadable');
      }
    }
  }

  if (issues.length) {
    console.log(`\nStatus: attention — ${issues.join('; ')}`);
    process.exit(1);
  }
  console.log('\nStatus: OK');
}

interface ShareExportCli {
  projectRoot: string;
  customDbPath: string | undefined;
  outDir: string | undefined;
}

function parseShareExportCli(argv: string[]): ShareExportCli {
  let projectRoot = process.cwd();
  let customDbPath: string | undefined;
  let outDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--project-root':
        projectRoot = resolve(argv[++i]);
        break;
      case '--db':
        customDbPath = argv[++i];
        break;
      case '--out':
        outDir = resolve(argv[++i]);
        break;
    }
  }
  return { projectRoot, customDbPath, outDir };
}

async function handleShareExport(): Promise<void> {
  const opts = parseShareExportCli(process.argv.slice(3));
  const dbPath = opts.customDbPath ?? join(opts.projectRoot, DEFAULT_DB_PATH);
  if (!existsSync(dbPath)) {
    console.error(`[aegis] Database not found at ${dbPath}`);
    console.error('[aegis] Run aegis init first, or specify --project-root / --db.');
    process.exit(1);
  }
  const db = await createDatabase(dbPath);
  const repo = new Repository(db);
  const outDir = opts.outDir ?? join(opts.projectRoot, 'aegis-share');

  try {
    const result = shareExport(repo, outDir);
    console.log('\nAegis share-export\n');
    console.log(`  output:            ${outDir}`);
    console.log(`  snapshot_id:       ${result.snapshot_id}`);
    console.log(`  knowledge_version: ${result.knowledge_version}`);
    console.log(`  bundle_sha256:     ${result.bundle_sha256}`);
    console.log(`  documents:         ${result.counts.documents}`);
    console.log(`  edges:             ${result.counts.edges}`);
    console.log(`  layer_rules:       ${result.counts.layer_rules}`);
    console.log(`  tag_mappings:      ${result.counts.tag_mappings}`);
    if (result.warnings.length) {
      console.log('\nWarnings:');
      for (const w of result.warnings) {
        console.log(`  ⚠ ${w}`);
      }
    }
    console.log('\nDone.');
  } catch (err) {
    console.error(`[aegis] share-export failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

interface ShareHydrateCli {
  projectRoot: string;
  customDbPath: string | undefined;
  bundleDir: string | undefined;
  replace: boolean;
}

function parseShareHydrateCli(argv: string[]): ShareHydrateCli {
  let projectRoot = process.cwd();
  let customDbPath: string | undefined;
  let bundleDir: string | undefined;
  let replace = false;
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--project-root':
        projectRoot = resolve(argv[++i]);
        break;
      case '--db':
        customDbPath = argv[++i];
        break;
      case '--bundle-dir':
        bundleDir = resolve(argv[++i]);
        break;
      case '--replace':
        replace = true;
        break;
    }
  }
  return { projectRoot, customDbPath, bundleDir, replace };
}

async function handleShareHydrate(): Promise<void> {
  const opts = parseShareHydrateCli(process.argv.slice(3));
  const dbPath = opts.customDbPath ?? join(opts.projectRoot, DEFAULT_DB_PATH);
  const bundleDirPath = opts.bundleDir ?? join(opts.projectRoot, 'aegis-share');

  try {
    const result = await shareHydrate({
      bundleDir: bundleDirPath,
      targetDbPath: dbPath,
      replace: opts.replace,
    });
    console.log('\nAegis share-hydrate\n');
    console.log(`  target_db:         ${dbPath}`);
    console.log(`  bundle_dir:        ${bundleDirPath}`);
    console.log(`  snapshot_id:       ${result.snapshot_id}`);
    console.log(`  knowledge_version: ${result.knowledge_version}`);
    console.log(`  documents:         ${result.counts.documents}`);
    console.log(`  edges:             ${result.counts.edges}`);
    console.log(`  layer_rules:       ${result.counts.layer_rules}`);
    console.log(`  tag_mappings:      ${result.counts.tag_mappings}`);
    console.log('\nWARNING: Local operational state (observations, proposals, compile_log) was NOT preserved.');
    console.log('Done.');
  } catch (err) {
    console.error(`[aegis] share-hydrate failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

interface ShareLintCli {
  projectRoot: string;
  sourceDir: string | undefined;
}

function parseShareLintCli(argv: string[]): ShareLintCli {
  let projectRoot = process.cwd();
  let sourceDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--project-root': {
        const val = argv[++i];
        if (!val) {
          console.error('[aegis] --project-root requires a value');
          process.exit(1);
        }
        projectRoot = resolve(val);
        break;
      }
      case '--source-dir': {
        const val = argv[++i];
        if (!val) {
          console.error('[aegis] --source-dir requires a value');
          process.exit(1);
        }
        sourceDir = resolve(val);
        break;
      }
    }
  }
  return { projectRoot, sourceDir };
}

function handleShareLint(): void {
  const opts = parseShareLintCli(process.argv.slice(3));
  const sourceDirPath = opts.sourceDir ?? join(opts.projectRoot, 'aegis-share', 'source');

  const result = shareLint(sourceDirPath);

  if (result.ok) {
    console.log('\nAegis share-lint\n');
    console.log(`  source:       ${sourceDirPath}`);
    console.log(`  documents:    ${result.counts.documents}`);
    console.log(`  edges:        ${result.counts.edges}`);
    console.log(`  layer_rules:  ${result.counts.layer_rules}`);
    console.log(`  tag_mappings: ${result.counts.tag_mappings}`);
    console.log('\nAll checks passed.');
  } else {
    console.error('\nAegis share-lint — errors found\n');
    console.error(`  source: ${sourceDirPath}\n`);
    for (const err of result.errors) {
      console.error(`  ✗ ${err.file}  [${err.location}]  ${err.message}`);
    }
    console.error(`\n  ${result.errors.length} error(s) found.`);
    process.exit(1);
  }
}

function handleShareFormat(): void {
  const opts = parseShareLintCli(process.argv.slice(3));
  const sourceDirPath = opts.sourceDir ?? join(opts.projectRoot, 'aegis-share', 'source');

  try {
    const result = shareFormat(sourceDirPath);
    console.log('\nAegis share-format\n');
    console.log(`  source:          ${sourceDirPath}`);
    console.log(`  files_changed:   ${result.files_changed}`);
    console.log(`  files_unchanged: ${result.files_unchanged}`);
    if (result.warnings.length) {
      console.log('\nWarnings:');
      for (const w of result.warnings) {
        console.log(`  ⚠ ${w}`);
      }
    }
    console.log('\nDone.');
  } catch (err) {
    console.error(`[aegis] share-format failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

interface ShareMaterializeCli {
  projectRoot: string;
  customDbPath: string | undefined;
  sourceDir: string | undefined;
  dryRun: boolean;
}

function parseShareMaterializeCli(argv: string[]): ShareMaterializeCli {
  let projectRoot = process.cwd();
  let customDbPath: string | undefined;
  let sourceDir: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--project-root': {
        const val = argv[++i];
        if (!val) {
          console.error('[aegis] --project-root requires a value');
          process.exit(1);
        }
        projectRoot = resolve(val);
        break;
      }
      case '--db':
        customDbPath = argv[++i];
        break;
      case '--source-dir': {
        const val = argv[++i];
        if (!val) {
          console.error('[aegis] --source-dir requires a value');
          process.exit(1);
        }
        sourceDir = resolve(val);
        break;
      }
      case '--dry-run':
        dryRun = true;
        break;
    }
  }
  return { projectRoot, customDbPath, sourceDir, dryRun };
}

async function handleShareMaterialize(): Promise<void> {
  const opts = parseShareMaterializeCli(process.argv.slice(3));
  const dbPath = opts.customDbPath ?? join(opts.projectRoot, DEFAULT_DB_PATH);
  const sourceDirPath = opts.sourceDir ?? join(opts.projectRoot, 'aegis-share', 'source');

  if (!existsSync(dbPath)) {
    console.error(`[aegis] Database not found at ${dbPath}`);
    console.error('[aegis] Run aegis init first, or specify --project-root / --db.');
    process.exit(1);
  }

  const db = await createDatabase(dbPath);
  const repo = new Repository(db);

  try {
    const result = shareMaterialize({
      sourceDir: sourceDirPath,
      repo,
      dryRun: opts.dryRun,
      projectRoot: opts.projectRoot,
    });

    const prefix = result.dry_run ? 'Aegis share-materialize (dry-run)' : 'Aegis share-materialize';
    console.log(`\n${prefix}\n`);
    console.log(`  source:            ${sourceDirPath}`);
    console.log(`  knowledge_version: ${result.knowledge_version}`);
    if (result.snapshot_id) {
      console.log(`  snapshot_id:       ${result.snapshot_id}`);
    }

    const c = result.changes;
    console.log('\n  Changes:');
    console.log(`    documents:   +${c.documents.added}  ~${c.documents.updated}  -${c.documents.removed}`);
    console.log(`    edges:       +${c.edges.added}  ~${c.edges.updated}  -${c.edges.removed}`);
    console.log(`    layer_rules: +${c.layer_rules.added}  ~${c.layer_rules.updated}  -${c.layer_rules.removed}`);
    console.log(`    tag_mappings: +${c.tag_mappings.added}  -${c.tag_mappings.removed}`);

    if (result.warnings.length) {
      console.log('\nWarnings:');
      for (const w of result.warnings) {
        console.log(`  ⚠ ${w}`);
      }
    }
    console.log('\nDone.');
  } catch (err) {
    console.error(`[aegis] share-materialize failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function handleShareSourceExport(): Promise<void> {
  const opts = parseShareExportCli(process.argv.slice(3));
  const dbPath = opts.customDbPath ?? join(opts.projectRoot, DEFAULT_DB_PATH);
  if (!existsSync(dbPath)) {
    console.error(`[aegis] Database not found at ${dbPath}`);
    console.error('[aegis] Run aegis init first, or specify --project-root / --db.');
    process.exit(1);
  }
  const db = await createDatabase(dbPath);
  const repo = new Repository(db);
  const outDir = opts.outDir ?? join(opts.projectRoot, 'aegis-share', 'source');

  try {
    const result = shareSourceExport(repo, outDir);
    console.log('\nAegis share-source-export\n');
    console.log(`  output:       ${outDir}`);
    console.log(`  documents:    ${result.counts.documents}`);
    console.log(`  edges:        ${result.counts.edges}`);
    console.log(`  layer_rules:  ${result.counts.layer_rules}`);
    console.log(`  tag_mappings: ${result.counts.tag_mappings}`);
    if (result.warnings.length) {
      console.log('\nWarnings:');
      for (const w of result.warnings) {
        console.log(`  ⚠ ${w}`);
      }
    }
    console.log('\nDone.');
  } catch (err) {
    console.error(`[aegis] share-source-export failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function main() {
  const subcommand = process.argv[2];

  if (subcommand === 'deploy-adapters') {
    handleDeployAdapters();
    return;
  }

  if (subcommand === 'maintenance') {
    await handleMaintenance();
    return;
  }

  if (subcommand === 'stats') {
    await handleStats();
    return;
  }

  if (subcommand === 'doctor') {
    await handleDoctor();
    return;
  }

  if (subcommand === 'share-export') {
    await handleShareExport();
    return;
  }

  if (subcommand === 'share-hydrate') {
    await handleShareHydrate();
    return;
  }

  if (subcommand === 'share-lint') {
    handleShareLint();
    return;
  }

  if (subcommand === 'share-format') {
    handleShareFormat();
    return;
  }

  if (subcommand === 'share-materialize') {
    await handleShareMaterialize();
    return;
  }

  if (subcommand === 'share-source-export') {
    await handleShareSourceExport();
    return;
  }

  const cliArgs = parseArgs();

  if (cliArgs.listModels) {
    printModels();
    process.exit(0);
  }

  const { surface, dbPath, templatesRoot, projectRoot } = cliArgs;

  // Ensure DB directory exists, with self-contained .gitignore
  const dbDir = join(dbPath, '..');
  mkdirSync(dbDir, { recursive: true });
  const gitignorePath = join(dbDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, '*\n');
  }

  const db = await createDatabase(dbPath);
  const repo = new Repository(db);
  const tagger = await createTagger(cliArgs);

  let adapterOutdated = false;
  if (repo.isInitialized()) {
    const meta = repo.getAdapterMeta();
    adapterOutdated = !meta || meta.deployed_version !== PACKAGE_VERSION;
    if (adapterOutdated) {
      console.error('[aegis] Adapter templates may be outdated. Run `npx @fuwasegu/aegis deploy-adapters` to update.');
    }
  }

  // Admin-only: migration 001 data step — source_path normalization (INV-6, ADR-013)
  if (surface === 'admin') {
    runInitialBaselineSourcePathMigration(repo, projectRoot);
  }

  const service = new AegisService(
    repo,
    templatesRoot,
    tagger,
    cliArgs.extraTemplateDirs,
    adapterOutdated,
    projectRoot,
  );
  const server = createAegisServer(service, surface);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`Aegis MCP server started (surface: ${surface})`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
