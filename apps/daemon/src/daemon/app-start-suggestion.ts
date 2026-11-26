import { SettingField, type SettingSuggestion } from '@10db/contracts';
import { parseRules } from '../trust';

// The app's start command the Workbench setup suggests: a Makefile target that brings the stack up, or
// the Compose file that defines it. Read from the base commit's files only; nothing runs.

/** Makefile targets that start a dev stack and return, in the order they are preferred. */
const UP_TARGETS = ['up', 'dev-up'] as const;
const MAKEFILES = ['Makefile', 'makefile', 'GNUmakefile'] as const;
const COMPOSE_FILES = [
  'compose.yaml',
  'compose.yml',
  'docker-compose.yaml',
  'docker-compose.yml',
] as const;

/** Said with the suggestion: when 10db runs it, and what it may open. */
export const APP_START_NOTE =
  'Run once when the app address does not answer before a picture or a sign-in, with Docker allowed; Docker Desktop is opened first when it is stopped';

/** The start command the repository points at, or null when it names none. */
export async function suggestAppStart(
  files: readonly string[],
  read: (path: string) => Promise<string | null>,
): Promise<SettingSuggestion | null> {
  const makefile = MAKEFILES.find((name) => files.includes(name));
  const text = makefile === undefined ? null : await read(makefile);
  if (makefile !== undefined && text !== null) {
    const rules = parseRules(text);
    const target = UP_TARGETS.find((name) => (rules.get(name) ?? []).length > 0);
    if (target !== undefined)
      return {
        field: SettingField.AppStartCommand,
        value: `make ${target}`,
        source: `from ${makefile}: the ${target} target`,
        note: APP_START_NOTE,
      };
  }
  const compose = COMPOSE_FILES.find((name) => files.includes(name));
  if (compose === undefined) return null;
  return {
    field: SettingField.AppStartCommand,
    value: 'docker compose up -d',
    source: `from ${compose}: it defines the stack`,
    note: APP_START_NOTE,
  };
}
