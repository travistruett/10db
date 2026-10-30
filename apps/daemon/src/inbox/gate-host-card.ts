import {
  InboxKind,
  type InboxAnswer,
  type InboxItemDto,
  type ProjectId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  insertDecision,
  insertPermissionRule,
  insertSource,
  listPermissionRules,
  type WriteContext,
} from '@10db/db';
import type { StateStore } from '../events';
import {
  checkConcreteHost,
  foundHostFile,
  matchPermissionRule,
  storableRule,
} from '../permissions';
import type { InboxService } from './service';

const NETWORK_TOOL = 'SandboxNetworkAccess';
const GATE_HOST_DETAIL = 'gateHost';
const MAX_COMMAND_CHARS = 400;

/** The answers a blocked-gate card offers; the card shows them as written. */
export const GateHostChoice = {
  Allow: 'Allow for the project',
  Later: 'Not now',
} as const;
export type GateHostChoice = (typeof GateHostChoice)[keyof typeof GateHostChoice];

function shown(command: string): string {
  const flat = command.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_COMMAND_CHARS ? `${flat.slice(0, MAX_COMMAND_CHARS)}…` : flat;
}

/**
 * Why a card recommends Allow: the project's own file needs the host. A lockfile or a registry setting
 * names it; a toolchain file (`.nvmrc`, `rust-toolchain.toml`) or `go.sum` only implies it, so the
 * wording claims neither.
 */
export function foundHostReason(file: string, host: string): string {
  return `The project's ${file} needs ${host}, so allowing it for the project is recommended.`;
}

function cardBody(host: string, command: string, file: string | null): string {
  const lines = [
    `The sandbox blocked the gate from reaching ${host}, and the gate failed.`,
    `Gate: ${shown(command)}`,
  ];
  if (file !== null) lines.push(foundHostReason(file, host));
  lines.push(
    'Allow it for the project and every later task, check and approved MCP server can reach it; then run the gate again.',
  );
  return lines.join('\n');
}

/**
 * Raises one card for each host a failed gate was blocked from: the host, the gate command and, when a
 * project file names the host as a registry, that file, with Allow for the project. A host already
 * allowed, or one a project may not be given (this machine, a whole top-level domain), gets no card.
 * A host asked about and not yet answered folds into its open card.
 */
export function raiseGateHostCards(
  deps: { readonly state: StateStore; readonly inbox: InboxService },
  input: {
    readonly projectId: ProjectId;
    readonly workstreamId: WorkstreamId | null;
    readonly command: string;
    readonly hosts: readonly string[];
  },
): InboxItemDto[] {
  const cards: InboxItemDto[] = [];
  for (const named of input.hosts) {
    let host: string;
    try {
      host = checkConcreteHost(named);
    } catch {
      continue;
    }
    const rules = listPermissionRules(deps.state.db, input.projectId, null);
    if (
      matchPermissionRule({ toolName: NETWORK_TOOL, input: { host } }, rules, { realPaths: [] })
    ) {
      continue;
    }
    const file = foundHostFile(deps.state.db, input.projectId, host);
    cards.push(
      deps.inbox.flag({
        projectId: input.projectId,
        workstreamId: input.workstreamId,
        title: `Allow network access to ${host}?`,
        body: cardBody(host, input.command, file),
        options: [
          {
            label: GateHostChoice.Allow,
            description: 'Every task, check and approved MCP server in this project can reach it',
          },
          { label: GateHostChoice.Later, description: 'Leave the gate failing for now' },
        ],
        recommendation: file === null ? null : GateHostChoice.Allow,
        detail: { [GATE_HOST_DETAIL]: host },
        foldKey: `gate-host:${input.projectId}:${host}`,
      }),
    );
  }
  return cards;
}

/**
 * Allow for the project on a blocked-gate card stores the project-wide rule a permission card's
 * Always allow does, in the answer's own transaction. Any other card, and any other answer, is left alone.
 */
export function applyGateHostChoice(
  ctx: WriteContext,
  item: InboxItemDto,
  answer: InboxAnswer,
): void {
  const host = item.detail?.[GATE_HOST_DETAIL];
  if (item.kind !== InboxKind.Flag || typeof host !== 'string') return;
  if (answer.choice !== GateHostChoice.Allow) return;
  const rule = storableRule(NETWORK_TOOL, host);
  if (rule === undefined) return;
  insertPermissionRule(ctx, {
    projectId: item.projectId,
    workstreamId: null,
    toolName: rule.toolName,
    pattern: rule.pattern,
    sourceInboxId: item.id,
  });
  insertDecision(ctx, {
    projectId: item.projectId,
    question: `Allow ${rule.toolName} (${host}) in this project?`,
    choice: 'Always allow',
    rationale: answer.note ?? 'Allowed for the project from a blocked gate',
    decidedBy: 'me',
    scope: 'project',
    area: null,
    sourceId: insertSource(ctx, 'inbox_answer', { inboxId: item.id }),
  });
}
