import {
  JudgeKind,
  PrecedentScope,
  TRUST_SWITCH_KEYS,
  type LimitName,
  type TrustSwitchKey,
} from '@10db/contracts';

/** One switch of Settings › Trust: its label, what it brings, and how each agent takes it. */
export interface TrustRow {
  readonly key: TrustSwitchKey;
  readonly label: string;
  /** One short line on what comes along with the switch on. */
  readonly description: string;
  /** The long version: what the switch does on Claude and on Codex. Shown behind a help button. */
  readonly providers: string;
  /** What a provider still lacks while the switch is on; null when nothing waits. */
  readonly whileOn: string | null;
}

const ROWS: Readonly<Record<TrustSwitchKey, Omit<TrustRow, 'key'>>> = {
  web: {
    label: 'Web',
    description: 'Lets sessions search and fetch the web.',
    providers:
      "On: Claude in auto mode judges each search and fetch, with no card; Claude on a model auto mode doesn't run is judged by 10db's judge. Off: no session searches or fetches without asking.",
    whileOn:
      "Codex searches the web live on OpenAI's servers, so 10db's judge doesn't see a search or page URL before it is fetched.",
  },
  projectInstructions: {
    label: 'Project Instructions',
    description: "The project's AGENTS.md, CLAUDE.md and rules.",
    providers:
      "The project's AGENTS.md, CLAUDE.md and .claude/rules, in each session's instructions. Claude: in the system prompt. Codex: as developer instructions, since Codex reads no AGENTS.md in a checkout 10db keeps untrusted.",
    whileOn: null,
  },
  yourInstructions: {
    label: 'Your Instructions',
    description: "Your ~/.claude/CLAUDE.md, after the project's.",
    providers: "Claude and Codex: after the project's instructions, in the same place.",
    whileOn: null,
  },
  yourSkills: {
    label: 'Your Skills',
    description: 'Skills from ~/.claude/skills and ~/.agents/skills.',
    providers:
      'Sessions read these skills but never change them. A skill kept directly in your home (~/x), under a hidden folder (~/.something) or in a project folder is left out; the list under the switch says why.',
    whileOn: null,
  },
  yourPlugins: {
    label: 'Your Plugins',
    description: 'Plugins Claude Code has installed, each switchable below.',
    providers:
      "Claude: skills, agents, commands and hooks, as Claude Code runs them. Their MCP servers are listed under Your MCP Servers. Codex: skills, and the plugins' MCP servers.",
    whileOn: null,
  },
  yourMcpServers: {
    label: 'Your MCP Servers',
    description: 'Servers from your Claude and Codex configs and plugins.',
    providers:
      "Each runs as Claude Code runs it, outside 10db's sandbox, from your home folder, and every call to it is judged. Claude and Codex sessions both get every approved server. Tool filters from config.toml apply in Codex sessions only. Servers that sign in with OAuth use the sign-in Claude Code or Codex keeps. Sessions on a Claude plan also get your claude.ai connectors. API key, Bedrock and Codex sessions don't, yet.",
    whileOn: null,
  },
  projectSkills: {
    label: 'Project Skills, Commands and Agents',
    description: "The project's skills, commands and agents.",
    providers:
      "Copied from the project's .claude folder with only the frontmatter that describes them. Codex: skills only.",
    whileOn: null,
  },
};

/** Settings › Trust's rows, in the order of the switches. */
export const TRUST_ROWS: readonly TrustRow[] = TRUST_SWITCH_KEYS.map((key) => ({
  key,
  ...ROWS[key],
}));

/** Who judges an account's calls, as Settings › Trust's Judge list names it. */
export const JUDGE_LABELS: Readonly<Record<JudgeKind, string>> = {
  [JudgeKind.Native]: "Claude Code's auto mode",
  [JudgeKind.Rules]: "10db's rules: a card where they can't decide",
  [JudgeKind.Tendb]: "10db's judge",
};

/** A tendb row while 10db's judge can't answer: no key, or a switch off. */
export const TENDB_NOT_READY_LABEL =
  "10db's rules: pick an account in Settings › Decisions for 10db's judge";

/** The Judge list's note: who 10db's judge judges. */
export const JUDGE_LIST_NOTE = "Accounts without auto mode, and Codex, use 10db's judge.";

/** What a native row adds: the model a task runs on can still put its session on the rules. */
export const NATIVE_JUDGE_NOTE =
  "On a model auto mode doesn't run, a session falls back to 10db's rules and says so in its thread.";

/** The project's Production card: what the list is, and what the judge does with it. */
export const PRODUCTION_DESCRIPTION =
  "Lanes may read these places, and 10db's judge refuses any write to them. Hosts, cloud profiles and namespaces, such as api.example.com or the prod AWS profile. Names with prod or production count already. Applies from the next session.";

/** A grant's limit as the project's Allowed in this project list names it; null is any limit. */
export const GRANT_LIMIT_LABELS: Readonly<Record<LimitName, string>> = {
  destroys_data: "Destroying Data It Didn't Create",
  sends_data_out: 'Sending Data Out',
  reads_secrets: 'Reading Secrets',
  writes_live: 'Writing to Live Systems',
};

export const GRANTS_DESCRIPTION =
  "A line that quotes one call applies, and stops, from the next call. A line in your own words is read by 10db's judge from the next call and by auto mode from the next session.";

export const GRANTS_EMPTY =
  "Nothing yet. \"Always in this project\" on a card adds a line here. Every judge reads a line that describes a kind of call. A line that quotes one call lets exactly that call through in Claude's auto mode and under 10db's judge, with no judge reading it; Codex's own Auto-review can still refuse it.";

/** A quoted call stored before grants named their tool: it matches no call, so it must be granted again. */
const UNNAMED_QUOTED_CALL = /^the call ".*"$/s;

/** The line under a grant: what it holds and when, or that it no longer applies. */
export function grantDescription(
  grant: { readonly limit: LimitName | null; readonly target: string },
  date: string,
): string {
  if (UNNAMED_QUOTED_CALL.test(grant.target))
    return `Grant again: this was saved before grants named their tool · ${date}`;
  return `${grant.limit === null ? 'Any limit' : GRANT_LIMIT_LABELS[grant.limit]} · ${date}`;
}

/** Where a standing approval holds, as Settings and the proposal card say it. */
export const PRECEDENT_SCOPE_LABELS: Readonly<Record<PrecedentScope, string>> = {
  [PrecedentScope.Copy]: 'In copies only',
  [PrecedentScope.Project]: 'Everywhere in this project, copies included',
};

export const STANDING_APPROVALS_DESCRIPTION =
  "Kinds of command you made routine. 10db's judge weighs one on every call of its kind; it never lets a call cross a limit.";

export const STANDING_APPROVALS_EMPTY =
  "Nothing yet. A card in the Inbox offers the kinds of command 10db's judge keeps doubting.";

/** Said while no account runs decisions: no model of 10db's can weigh a kind, so none is offered or stored. */
export const STANDING_APPROVALS_NEEDS_ACCOUNT = 'Standing approvals need a Decisions account';

/** Beside Remove: auto mode reads the approved kinds once, when a session starts. */
export const PRECEDENT_REMOVE_NOTE =
  'A running Claude session in auto mode keeps this until it next starts.';

export const NOT_ROUTINE_DESCRIPTION =
  'Kinds you kept skipping or removed. Approve makes one routine again.';
