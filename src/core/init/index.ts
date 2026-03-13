export { detectStack, resolvePlaceholders, scoreProfile } from './detector.js';
export type { InitPreview } from './engine.js';
export { initConfirm, initDetect, PreviewHashMismatchError } from './engine.js';
export {
  calculateSpecificity,
  evaluateWhen,
  expandPlaceholders,
  loadAllManifests,
  loadManifest,
  resolveTemplate,
} from './template-loader.js';
export type { UpgradeChange, UpgradePreview } from './upgrade.js';
export { detectUpgrade, generateUpgradeProposals } from './upgrade.js';
