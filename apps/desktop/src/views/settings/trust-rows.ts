import { JudgeKind, TRUST_SWITCH_KEYS, type LimitName, type TrustSwitchKey } from '@10db/contracts';

/** One switch of Settings › Trust: its label, what it brings, and how each agent takes it. */
export interface TrustRow {
  readonly key: TrustSwitchKey;
  readonly label: string;
  /** What comes along with the switch on; ends saying when a change applies. */
  readonly description: string;
  /** What the switch does on Claude and on Codex, and what each still lacks. */
  readonly providers: string;
  /** What a provider still lacks while the switch is on; null when nothing waits. */
  readonly whileOn: string | null;
}

const NEXT = 'Applies from the next session.';

const ROWS: Readonly<Record<TrustSwitchKey, Omit<TrustRow, 'key'>>> = {
  web: {
    label: 'Web',
    description: `Lets sessions search and fetch the web. ${NEXT}`,
    providers:
      "On: Claude in auto mode judges each search and fetch, with no card; Claude through a gateway, or on a model auto mode doesn't run, is judged by 10db's judge. Off: no session searches or fetches without asking.",
    whileOn: 'Web search on ChatGPT comes after a live check: Codex sessions search nothing yet.',
  },
  projectInstructions: {
    label: 'Project instructions',
    description: `The project's AGENTS.md, CLAUDE.md and .claude/rules, in each session's instructions. ${NEXT}`,
    providers:
      'Claude: in the system prompt. Codex: as developer instructions, since Codex reads no AGENTS.md in a checkout 10db keeps untrusted.',
    whileOn: null,
  },
  yourInstructions: {
    label: 'Your instructions',
    description: `Your ~/.claude/CLAUDE.md, after the project's. ${NEXT}`,
    providers: "Claude and Codex: after the project's instructions, in the same place.",
    whileOn: null,
  },
  yourSkills: {
    label: 'Your skills',
    description: `The skills in ~/.claude/skills and ~/.agents/skills, which sessions read but never change. ${NEXT}`,
    providers:
      'A skill kept directly in your home (~/x), under a hidden folder (~/.something) or in a project folder is left out; Comes along says why.',
    whileOn: null,
  },
  yourPlugins: {
    label: 'Your plugins',
    description: `The plugins Claude Code has installed for you, each switchable below. ${NEXT}`,
    providers:
      "Claude: skills, agents, commands and hooks, as Claude Code runs them; their MCP servers wait for 10db's support for your MCP servers. Codex: skills only.",
    whileOn: null,
  },
  projectSkills: {
    label: 'Project skills, commands and agents',
    description: `The project's .claude/skills, commands and agents, copied with only the frontmatter that describes them. ${NEXT}`,
    providers: 'Codex: skills only.',
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
  "10db's rules: add an OpenRouter key in Settings › Decisions for 10db's judge";

/** The Judge list's note: who 10db's judge judges. */
export const JUDGE_LIST_NOTE = "Accounts without auto mode, and Codex, use 10db's judge.";

/** What a native row adds: the model a task runs on can still put its session on the rules. */
export const NATIVE_JUDGE_NOTE =
  "On a model auto mode doesn't run, a session falls back to 10db's rules and says so in its thread.";

/** The project's Live systems input: what an entry is, and when a change applies. */
export const LIVE_SYSTEMS_DESCRIPTION = `Hosts, cloud profiles and namespaces the judge treats as live, such as api.example.com or the prod AWS profile. Names with prod or production count already. ${NEXT}`;

/** A grant's limit as the project's Allowed in this project list names it; null is any limit. */
export const GRANT_LIMIT_LABELS: Readonly<Record<LimitName, string>> = {
  destroys_data: "Destroying data it didn't create",
  sends_data_out: 'Sending data out',
  reads_secrets: 'Reading secrets',
  writes_live: 'Writing to live systems',
};

export const GRANTS_DESCRIPTION =
  "10db's judge reads a change from the next call; auto mode from the next session.";

export const GRANTS_EMPTY =
  'Nothing yet. "Always in this project" on a card adds a line here, and every judge on the project reads it.';
