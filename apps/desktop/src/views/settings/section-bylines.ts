import { SettingsSectionKey } from './sections';

/**
 * Each Settings page's byline: one line, about 90 characters at most, on what the page is for. A page whose
 * purpose is plain from its name (General, Appearance, Keep-Awake, Sessions) has none. A page at both scopes
 * says how the other scope relates in the same line.
 */
export const SECTION_BYLINES: Readonly<Partial<Record<SettingsSectionKey, string>>> = {
  [SettingsSectionKey.PagesAndPictures]:
    'How 10db opens your app, so agents can check pages and take pictures.',
  [SettingsSectionKey.Sharing]:
    "Where this project's work shows outside 10db: pull requests and Slack.",
  [SettingsSectionKey.BoardColumns]:
    'Your columns park tasks; the rest follow where each task stands.',
  [SettingsSectionKey.Planning]: "How Plan treats this project's work before a lane starts it.",
  [SettingsSectionKey.Areas]: 'The parts of this project, and the files that are risky to change.',
  [SettingsSectionKey.Watchpoints]: 'Files whose changes you judge yourself.',
  [SettingsSectionKey.RoutingRules]: 'Who answers each kind of question; the first match wins.',
  [SettingsSectionKey.Linear]: "Whether this project's work reports to Linear.",
  [SettingsSectionKey.Team]: "Who does this project's work. Use Global follows All Projects.",
  [SettingsSectionKey.Billing]:
    "Which account pays for this project's work, and what a task may spend.",
  [SettingsSectionKey.ProjectTrust]:
    'What agents may do here unasked. Defaults follow All Projects.',
  [SettingsSectionKey.NetworkHosts]:
    "What this project's tasks may run and reach from inside the sandbox.",
  [SettingsSectionKey.Overview]: 'Every connection 10db needs, and whether each one works.',
  [SettingsSectionKey.Accounts]: 'The plans and keys 10db runs agents and decisions on.',
  [SettingsSectionKey.Playbook]:
    'Who does the work: the steps at each rigor, and the kinds of work.',
  [SettingsSectionKey.Decisions]:
    'Small calls 10db makes many times a day, and the model that makes each.',
  [SettingsSectionKey.Models]:
    'What the Playbook and decisions choose from, scored and priced on your account.',
  [SettingsSectionKey.LanePermissions]:
    "How a lane's agent gets permission to run commands. Applies next session.",
  [SettingsSectionKey.Trust]: 'What agents may do unasked in every project. Applies next session.',
  [SettingsSectionKey.AllWatchpoints]: 'Files whose changes you judge yourself.',
  [SettingsSectionKey.Integrations]:
    "Outside services 10db uses that aren't models. Models are in Accounts.",
  [SettingsSectionKey.People]:
    "Who answers your projects' questions, and how 10db reaches each one.",
  [SettingsSectionKey.RemoteAccess]: "Reach this Mac's 10db from your phone, privately.",
  [SettingsSectionKey.Devices]: 'Paired phones and Macs; each has full access.',
  [SettingsSectionKey.Updates]: 'How 10db and the agents it runs stay up to date.',
  [SettingsSectionKey.AgentSkill]:
    'Lets a Claude Code or Codex session in any repo work with 10db.',
};
