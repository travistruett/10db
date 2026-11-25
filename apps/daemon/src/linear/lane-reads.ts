import { Provider } from '@10db/contracts';
import { linearToolPrefixes, secretIn } from './reporter-guard';

const LINEAR_HOST = 'mcp.linear.app';

/** Whether a remote server's url is Linear's own host. */
export function isLinearServer(url: string): boolean {
  try {
    return new URL(url).host === LINEAR_HOST;
  } catch {
    return false;
  }
}

/**
 * The Linear tools a lane may call as a settled read: each sends Linear only the ids and filters it names.
 * `extract_images` is left out because it fetches URLs, and every tool that writes is left out.
 */
const LANE_LINEAR_READS: ReadonlySet<string> = new Set([
  'whoami',
  'search_documentation',
  'get_attachment',
  'get_diff',
  'get_diff_threads',
  'get_document',
  'get_issue',
  'get_issue_status',
  'get_milestone',
  'get_project',
  'get_release',
  'get_release_note',
  'get_status_updates',
  'get_team',
  'get_template',
  'get_triage_responsibility',
  'get_user',
  'get_workspace',
  'get_agent_skill',
  'get_notifications',
  'list_agent_skills',
  'list_comments',
  'list_custom_views',
  'list_cycles',
  'list_diffs',
  'list_documents',
  'list_issue_labels',
  'list_issue_statuses',
  'list_issues',
  'list_milestones',
  'list_project_labels',
  'list_projects',
  'list_release_notes',
  'list_release_pipelines',
  'list_releases',
  'list_teams',
  'list_templates',
  'list_users',
]);

/** A read whose input JSON is longer than this carries more than ids and filters, so it is judged. */
const LINEAR_READ_INPUT_MAX_CHARS = 2_000;

/**
 * The tool-name prefixes of the Linear servers a lane's session registers: the claude.ai connector on
 * Claude, and each of the builder's remote servers on `mcp.linear.app`, by the name the harness registers
 * it under (Claude's `claudeName` where it has one, Codex's the plan's own name).
 */
export function laneLinearPrefixes(session: {
  readonly remote: Readonly<
    Record<string, { readonly url: string; readonly claudeName: string | null }>
  >;
  readonly connectors: boolean;
  readonly harness: Provider;
}): string[] {
  const entries = Object.entries(session.remote)
    .filter(([, server]) => isLinearServer(server.url))
    .map(([name, server]) =>
      session.harness === Provider.Claude ? (server.claudeName ?? name) : name,
    );
  return linearToolPrefixes({
    connector: session.connectors,
    entries,
    harness: session.harness,
  });
}

const isRecord = (input: unknown): boolean =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

/**
 * Pure: whether a lane's call is a read of the builder's own Linear: a listed read tool on one of
 * `prefixes`, with a record input no longer than `LINEAR_READ_INPUT_MAX_CHARS` and no string matching a
 * secret pattern.
 */
export function isLaneLinearRead(
  prefixes: readonly string[],
  toolName: string,
  input: unknown,
): boolean {
  const prefix = prefixes.find((p) => toolName.startsWith(p));
  if (prefix === undefined || !LANE_LINEAR_READS.has(toolName.slice(prefix.length))) return false;
  if (input !== undefined && !isRecord(input)) return false;
  if (JSON.stringify(input ?? {}).length > LINEAR_READ_INPUT_MAX_CHARS) return false;
  return secretIn(input) === null;
}
