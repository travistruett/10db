export { acquireInstanceLock, AlreadyRunningError } from './instance-lock';
export { readRuntimeInfo } from '../runtime-files';
export { aaKeyReaderFromEnv, daemonOptionsFromEnv } from './options-from-env';
export { createKnowledgeServices } from './knowledge-services';
export { startDaemon, type RunningDaemon } from './start';
export { WorktreeRootError } from './worktree-root';
