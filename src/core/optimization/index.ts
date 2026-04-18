export {
  aggregateRefactorSignals,
  buildSplitCandidatePayload,
  cohortMedianGapRateForKind,
  DEFAULT_REFACTOR_TRIGGER,
  DOC_REFACTOR_ALGORITHM_VERSION,
  type DocRefactorAggregate,
  effectiveGapRateThreshold,
  finiteMedian,
  gapRate,
  type RefactorTrigger,
  shouldEmitSplitCandidate,
} from './doc-refactor.js';
export {
  buildCoverageOptimizationContext,
  buildMissClustersFromObservations,
  buildPathClustersFromFiles,
  derivePathPattern,
  type MissCluster,
  type PathCluster,
} from './edge-candidate-builder.js';
export {
  deterministicPathProbesForGlob,
  type EdgeValidationImpact,
  type EdgeValidationResult,
  isCanonicalDirTreeGlob,
  pathGlobSubsumes,
  type ValidatePathRequiresEdgeInput,
  validatePathRequiresEdge,
} from './edge-validation.js';
export {
  collectSemanticStalenessFindings,
  extractTsExportedSymbols,
  findRenameCandidatePath,
  fingerprintEdgeLinkedArtifacts,
  linkedPathsForDoc,
  listRepoRelativeFiles,
  SEMANTIC_STALENESS_ALGORITHM_VERSION,
  type SemanticStalenessScanInput,
  type SemanticStalenessScanResult,
  stableStringifyFingerprints,
} from './staleness.js';
