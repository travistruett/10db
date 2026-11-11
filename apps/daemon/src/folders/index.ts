export { gateCandidates, GateSource, type FolderFiles } from './gate-candidates';
export { modelJson, oneLine } from './area-naming';
export { inspectFolder } from './inspect';
export { proposeAreas, type AreaNamer } from './propose-areas';
export { proposePageAreas } from './propose-pages';
export { askWithin } from './ask-within';
export {
  appAddressCandidates,
  appAddressFiles,
  chooseAppAddress,
  PROBED,
  type AddressCandidate,
  type Listener,
} from './detect-app-address';
export { CHANGED_CHECK_NOTE, changedCheckFor, uiUnitOf } from './detect-changed-check';
export {
  devLoginAnswer,
  devLoginEvidence,
  devLoginPrompt,
  devLoginScriptFiles,
  findDevLogins,
} from './detect-dev-login';
