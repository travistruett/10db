import type { ProjectId } from '@10db/contracts';
import type { DbReader } from '@10db/db';
import { mcpApprovals, trustSwitchesFor } from '../permissions';
import type { LeftOut } from './left-out';
import { readYourMcpConfig } from './your-mcp-config';
import { planYourMcp, type YourMcpPlan } from './your-mcp-plan';

/**
 * The builder's own MCP servers one session starts with: their files and loaded plugins read, then planned
 * from the project's switches, the approvals and the login environment. A file problem becomes a left-out
 * item. The session's set is fixed here; an approval or a switch applies from the next session.
 */
export function yourMcpForSession(args: {
  readonly db: DbReader;
  readonly home: string;
  readonly projectId: ProjectId;
  /** Every name in the repo's `.mcp.json`, approved or not: the project's name wins. */
  readonly projectServerNames: readonly string[];
  /** The login environment without billing switches (`Launcher.projectEnv()`). */
  readonly loginEnv: Readonly<Record<string, string>>;
  /** Every root a lane can write: the builder's files may not lead into one. */
  readonly laneWritable: readonly string[];
  /** Whether any project's lane may bind local ports (its loopback switch): its commands could listen where a lane of this session connects. */
  readonly localBinding: boolean;
  /** The plugins the session loads, so one switched off brings no servers. */
  readonly plugins: readonly { readonly id: string; readonly installPath: string }[];
  /** Told what a stored switch or approvals value held when it isn't the shape 10db reads. */
  readonly onInvalid: (stored: unknown) => void;
}): YourMcpPlan {
  const switches = trustSwitchesFor(args.db, args.projectId, args.onInvalid);
  const { entries, fileProblems } = readYourMcpConfig({
    home: args.home,
    laneWritable: args.laneWritable,
    plugins: switches.yourMcpServers ? args.plugins : [],
  });
  const planned = planYourMcp({
    entries,
    switches,
    approvals: mcpApprovals(args.db, args.onInvalid),
    projectServerNames: args.projectServerNames,
    loginEnv: args.loginEnv,
    localBinding: args.localBinding,
  });
  const problems: LeftOut[] = switches.yourMcpServers ? fileProblems : [];
  return { ...planned, leftOut: [...problems, ...planned.leftOut] };
}
