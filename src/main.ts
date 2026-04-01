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
 *   npx aegis --list-models                      # List available SLM models
 *
 * SLM is disabled by default (ADR-004). Enable with --slm for expanded context.
 * Models are stored in ~/.aegis/models/ (shared across projects).
 * DB defaults to .aegis/aegis.db (per project).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
import { AegisService } from './mcp/services.js';

const PACKAGE_VERSION: string = JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf-8')).version;

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
  let templatesRoot = join(import.meta.dirname, '../templates');
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
  const templatesRoot = join(import.meta.dirname, '../templates');
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

async function main() {
  const subcommand = process.argv[2];

  if (subcommand === 'deploy-adapters') {
    handleDeployAdapters();
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
