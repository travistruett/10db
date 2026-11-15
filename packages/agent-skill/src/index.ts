import { resolve } from 'node:path';

export { runCommand, type CommandDeps } from './commands';
export { connectionFrom, httpApi } from './connection';
export { TendbError } from './errors';

/** The skill's hand-written files: `SKILL.md` and `README.md`. */
export const AGENT_SKILL_SOURCE_DIR = resolve(import.meta.dirname, '../skill');
