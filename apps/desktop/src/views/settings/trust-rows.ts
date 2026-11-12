import { TRUST_SWITCH_KEYS, type TrustSwitchKey } from '@10db/contracts';

/** One switch of Settings › Trust: its label, what it brings, and how each agent takes it. */
export interface TrustRow {
  readonly key: TrustSwitchKey;
  readonly label: string;
  /** What comes along with the switch on; ends saying when a change applies. */
  readonly description: string;
  /** What the switch does on Claude and on Codex, and what each still lacks. */
  readonly providers: string;
}

const NEXT = 'Applies from the next session.';

const ROWS: Readonly<Record<TrustSwitchKey, Omit<TrustRow, 'key'>>> = {
  web: {
    label: 'Web',
    description: `Lets sessions search and fetch the web. ${NEXT}`,
    providers:
      "On: Claude in auto mode judges each search and fetch, with no card. Claude through a gateway, and Codex, still card it until 10db's judge comes. Off: every search and fetch waits on a card.",
  },
  projectInstructions: {
    label: 'Project instructions',
    description: `The project's AGENTS.md, CLAUDE.md and .claude/rules, in each session's instructions. ${NEXT}`,
    providers:
      'Claude: in the system prompt. Codex: as developer instructions, since Codex reads no AGENTS.md in a checkout 10db keeps untrusted.',
  },
  yourInstructions: {
    label: 'Your instructions',
    description: `Your ~/.claude/CLAUDE.md, after the project's. ${NEXT}`,
    providers: "Claude and Codex: after the project's instructions, in the same place.",
  },
  yourSkills: {
    label: 'Your skills',
    description: `The skills in ~/.claude/skills and ~/.agents/skills, which sessions read but never change. ${NEXT}`,
    providers:
      'A skill kept directly in your home (~/x), under a hidden folder (~/.something) or in a project folder is left out; Comes along says why.',
  },
  yourPlugins: {
    label: 'Your plugins',
    description: `The plugins Claude Code has installed for you, each switchable below. ${NEXT}`,
    providers:
      "Claude: skills, agents, commands and hooks, as Claude Code runs them; their MCP servers wait for 10db's support for your MCP servers. Codex: skills only.",
  },
  projectSkills: {
    label: 'Project skills, commands and agents',
    description: `The project's .claude/skills, commands and agents, copied with only the frontmatter that describes them. ${NEXT}`,
    providers: 'Codex: skills only.',
  },
};

/** Settings › Trust's rows, in the order of the switches. */
export const TRUST_ROWS: readonly TrustRow[] = TRUST_SWITCH_KEYS.map((key) => ({
  key,
  ...ROWS[key],
}));
