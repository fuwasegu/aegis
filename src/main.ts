#!/usr/bin/env node
/**
 * Aegis MCP Server Entry Point
 *
 * Usage:
 *   npx aegis --surface agent                    # Agent surface (default)
 *   npx aegis --surface admin                    # Admin surface
 *   npx aegis --model qwen2.5-1.5b              # Select SLM from catalog
 *   npx aegis --model hf:user/repo:file.gguf    # Custom HuggingFace model
 *   npx aegis --no-slm                           # Disable SLM (no expanded context)
 *   npx aegis --ollama                           # Use Ollama instead of llama.cpp
 *
 * Models are stored in ~/.aegis/models/ (shared across projects).
 * DB defaults to .aegis/aegis.db (per project).
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createDatabase } from './core/store/database.js';
import { Repository } from './core/store/repository.js';
import { AegisService } from './mcp/services.js';
import { createAegisServer } from './mcp/server.js';
import { LlamaEngine } from './expansion/llama-engine.js';
import { LlamaIntentTagger } from './expansion/llama-intent-tagger.js';
import { OllamaClient } from './expansion/ollama-client.js';
import { OllamaIntentTagger } from './expansion/intent-tagger.js';
import { DEFAULT_MODEL, MODEL_CATALOG, listAvailableModels } from './expansion/models.js';
import type { Surface } from './mcp/services.js';
import type { IntentTagger } from './core/tagging/tagger.js';

const DEFAULT_DB_DIR = '.aegis';
const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, 'aegis.db');

const KNOWN_TAGS = [
  'state_mutation', 'collection_operation', 'db_migration', 'api_endpoint',
  'authentication', 'authorization', 'validation', 'error_handling', 'logging',
  'caching', 'event_dispatch', 'external_api', 'file_operation', 'query_optimization',
];

interface CliArgs {
  surface: Surface;
  dbPath: string;
  templatesRoot: string;
  model: string;
  noSlm: boolean;
  useOllama: boolean;
  ollamaUrl: string;
  listModels: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let surface: Surface = 'agent';
  let dbPath = DEFAULT_DB_PATH;
  let templatesRoot = join(import.meta.dirname, '../templates');
  let model = DEFAULT_MODEL;
  let noSlm = false;
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
      case '--model':
        model = args[++i];
        break;
      case '--no-slm':
      case '--no-ollama':
        noSlm = true;
        break;
      case '--ollama':
        useOllama = true;
        break;
      case '--ollama-url':
        ollamaUrl = args[++i];
        break;
      case '--ollama-model':
        model = args[++i];
        break;
      case '--list-models':
        listModels = true;
        break;
    }
  }

  return { surface, dbPath, templatesRoot, model, noSlm, useOllama, ollamaUrl, listModels };
}

async function createTagger(cliArgs: CliArgs): Promise<IntentTagger | null> {
  if (cliArgs.noSlm) return null;

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
    return new LlamaIntentTagger(engine, KNOWN_TAGS);
  } catch (err) {
    console.error(`[aegis] llama.cpp initialization failed: ${err instanceof Error ? err.message : err}`);
    console.error('[aegis] Expanded context disabled. Use --no-slm to suppress this warning.');
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
  return new OllamaIntentTagger(client, KNOWN_TAGS);
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

async function main() {
  const cliArgs = parseArgs();

  if (cliArgs.listModels) {
    printModels();
    process.exit(0);
  }

  const { surface, dbPath, templatesRoot } = cliArgs;

  // Ensure DB directory exists, with self-contained .gitignore
  const dbDir = join(dbPath, '..');
  mkdirSync(dbDir, { recursive: true });
  const gitignorePath = join(dbDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, '*\n');
  }

  const db = createDatabase(dbPath);
  const repo = new Repository(db);
  const tagger = await createTagger(cliArgs);
  const service = new AegisService(repo, templatesRoot, tagger);
  const server = createAegisServer(service, surface);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`Aegis MCP server started (surface: ${surface})`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
