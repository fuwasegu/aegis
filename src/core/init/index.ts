export { initDetect, initConfirm, PreviewHashMismatchError } from './engine.js';
export type { InitPreview } from './engine.js';
export { loadManifest, loadAllManifests, calculateSpecificity, evaluateWhen, expandPlaceholders, resolveTemplate } from './template-loader.js';
export { detectStack, scoreProfile, resolvePlaceholders } from './detector.js';
export { detectUpgrade, generateUpgradeProposals } from './upgrade.js';
export type { UpgradePreview, UpgradeChange } from './upgrade.js';
