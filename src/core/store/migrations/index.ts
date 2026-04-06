export { migration001, runInitialBaselineSourcePathMigration } from './001_initial_baseline.js';
export { migration002, upAddAuditMeta } from './002_add_audit_meta.js';
export { migration003, upAddDocGapEventType } from './003_add_doc_gap_event_type.js';
export { migration004, upAddDocumentsOwnership } from './004_add_documents_ownership.js';
export { migration005, upExpandProposalTypeEdgeMutations } from './005_expand_proposal_type_edge_mutations.js';
export { ensureSchemaMigrationsTable, runMigrations } from './runner.js';
export type { Migration } from './types.js';

import { migration001 } from './001_initial_baseline.js';
import { migration002 } from './002_add_audit_meta.js';
import { migration003 } from './003_add_doc_gap_event_type.js';
import { migration004 } from './004_add_documents_ownership.js';
import { migration005 } from './005_expand_proposal_type_edge_mutations.js';

/** Registered migrations in version order (append new migrations here). */
export const ALL_MIGRATIONS = [migration001, migration002, migration003, migration004, migration005];
