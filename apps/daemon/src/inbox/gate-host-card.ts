import { InboxKind, type InboxAnswer, type InboxItemDto, type ProjectId } from '@10db/contracts';
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
import { BlockedRun } from '../verify';
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

/** How a card names what the sandbox blocked, and what to do once the host is allowed. */
const RUN_WORDS: Readonly<
  Record<
    BlockedRun,
    {
      readonly what: string;
      readonly short: string;
      readonly label: string;
      readonly then: string;
    }
  >
> = {
  [BlockedRun.Gate]: {
    what: 'the gate',
    short: 'the gate',
    label: 'Gate',
    then: 'run the gate again',
  },
  [BlockedRun.Install]: {
    what: "10db's install of a worktree's packages",
    short: 'the install',
    label: 'Install',
    then: 'try again',
  },
};

function cardBody(run: BlockedRun, host: string, command: string, file: string | null): string {
  const words = RUN_WORDS[run];
  const lines = [
    `The sandbox blocked ${words.what} from reaching ${host}, and ${words.short} failed.`,
    `${words.label}: ${shown(command)}`,
  ];
  if (file !== null) lines.push(foundHostReason(file, host));
  lines.push(
    `Allow it for the project and every later task, check and approved MCP server can reach it; then ${words.then}.`,
  );
  return lines.join('\n');
}

/**
 * Raises one card for each host a failed gate, or 10db's install of a worktree's packages under the
 * gate's sandbox, was blocked from: the host, the command and, when a project file names the host as a
 * registry, that file, with Allow for the project. A host already allowed, or one a project may not be
 * given (this machine, a whole top-level domain), gets no card. A host asked about and not yet answered
 * folds into its open card, whichever run asked. The card is the project's and targets no workstream:
 * its answer allows the host for every lane and gate, and cancelling the lane whose gate raised it must
 * not withdraw it while another gate needs the host.
 */
export function raiseGateHostCards(
  deps: { readonly state: StateStore; readonly inbox: InboxService },
  input: {
    readonly projectId: ProjectId;
    readonly run: BlockedRun;
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
        workstreamId: null,
        title: `Allow network access to ${host}?`,
        body: cardBody(input.run, host, input.command, file),
        options: [
          {
            label: GateHostChoice.Allow,
            description: 'Every task, check and approved MCP server in this project can reach it',
          },
          {
            label: GateHostChoice.Later,
            description: `Leave ${RUN_WORDS[input.run].short} failing for now`,
          },
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
