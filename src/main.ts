#!/usr/bin/env node
/**
 * Aegis MCP Server Entry Point
 *
 * Usage:
 *   npx aegis --surface agent                  # Agent surface (default DB: .aegis/aegis.db)
 *   npx aegis --surface admin                  # Admin surface
 *   npx aegis --surface agent --db ./my.db     # Custom DB path
 *
 * The DB defaults to .aegis/aegis.db (relative to CWD = project root).
 * init_detect → init_confirm must run within a single admin process (previewCache is in-memory).
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createDatabase } from './core/store/database.js';
import { Repository } from './core/store/repository.js';
import { AegisService } from './mcp/services.js';
import { createAegisServer } from './mcp/server.js';
import { OllamaClient } from './expansion/ollama-client.js';
import { OllamaIntentTagger } from './expansion/intent-tagger.js';
import type { Surface } from './mcp/services.js';
import type { IntentTagger } from './core/tagging/tagger.js';

const DEFAULT_DB_DIR = '.aegis';
const DEFAULT_DB_PATH = join(DEFAULT_DB_DIR, 'aegis.db');

interface CliArgs {
  surface: Surface;
  dbPath: string;
  templatesRoot: string;
  ollamaUrl: string;
  ollamaModel: string;
  noOllama: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let surface: Surface = 'agent';
  let dbPath = DEFAULT_DB_PATH;
  let templatesRoot = join(import.meta.dirname, '../templates');
  let ollamaUrl = 'http://localhost:11434';
  let ollamaModel = 'qwen3:1.7b';
  let noOllama = false;

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
      case '--ollama-url':
        ollamaUrl = args[++i];
        break;
      case '--ollama-model':
        ollamaModel = args[++i];
        break;
      case '--no-ollama':
        noOllama = true;
        break;
    }
  }

  return { surface, dbPath, templatesRoot, ollamaUrl, ollamaModel, noOllama };
}

async function createTagger(cliArgs: CliArgs): Promise<IntentTagger | null> {
  if (cliArgs.noOllama) return null;

  const client = new OllamaClient({
    baseUrl: cliArgs.ollamaUrl,
    model: cliArgs.ollamaModel,
  });

  const healthy = await client.isHealthy();
  if (!healthy) {
    console.error(`[aegis] Ollama not reachable at ${cliArgs.ollamaUrl} — expanded context disabled`);
    return null;
  }

  console.error(`[aegis] Ollama connected (model: ${cliArgs.ollamaModel})`);
  const knownTags = ['state_mutation', 'collection_operation', 'db_migration', 'api_endpoint',
    'authentication', 'authorization', 'validation', 'error_handling', 'logging',
    'caching', 'event_dispatch', 'external_api', 'file_operation', 'query_optimization'];
  return new OllamaIntentTagger(client, knownTags);
}

async function main() {
  const cliArgs = parseArgs();
  const { surface, dbPath, templatesRoot } = cliArgs;

  // Ensure DB directory exists
  const dbDir = join(dbPath, '..');
  mkdirSync(dbDir, { recursive: true });

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
