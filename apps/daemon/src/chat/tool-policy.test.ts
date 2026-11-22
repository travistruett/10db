import { BuilderToolName, ChatGitToolName, ChatToolName } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { CHAT_MCP_TOOLS, chatProfile } from './hooks';
import { CHAT_TOOL_POLICY } from './tool-policy';

// Sessions spec §6.6: every builder tool is on a chat's server, plus set_title, link_linear_team and the git tools; four ask the builder.

const ASKS = ['remove_task', 'retire_knowledge', 'withdraw_knowledge', 'supersede_knowledge'];

const JUDGED: string[] = [
  ChatToolName.PushBranch,
  ChatToolName.OpenPullRequest,
  ChatToolName.MergePullRequest,
];

describe('the chat tool policy', () => {
  it.each(
    [
      ...Object.values(BuilderToolName),
      ChatToolName.SetTitle,
      ChatToolName.LinkLinearTeam,
      ...Object.values(ChatGitToolName),
    ].map((name) => ({ name })),
  )('$name has its policy', ({ name }) => {
    expect(CHAT_TOOL_POLICY[name]).toBe(
      ASKS.includes(name) ? 'asks' : JUDGED.includes(name) ? 'judged' : 'runs',
    );
  });

  it('names every builder tool, set_title and the git tools, and nothing else', () => {
    expect(new Set(Object.values(ChatToolName))).toEqual(
      new Set([
        ...Object.values(BuilderToolName),
        'set_title',
        'link_linear_team',
        ...Object.values(ChatGitToolName),
      ]),
    );
    expect(new Set(Object.keys(CHAT_TOOL_POLICY))).toEqual(new Set(Object.values(ChatToolName)));
  });

  it('asks on exactly four, and puts every tool but the three that reach GitHub in allowedTools', () => {
    expect(
      Object.entries(CHAT_TOOL_POLICY)
        .filter(([, policy]) => policy === 'asks')
        .map(([name]) => name)
        .sort(),
    ).toEqual([...ASKS].sort());
    const allowed = chatProfile(true).allowedTools;
    for (const name of Object.values(ChatToolName))
      expect(allowed.includes(`mcp__10db__${name}`)).toBe(!JUDGED.includes(name));
    expect(
      Object.entries(CHAT_TOOL_POLICY)
        .filter(([, policy]) => policy === 'judged')
        .map(([name]) => name)
        .sort(),
    ).toEqual([...JUDGED].sort());
    expect(CHAT_MCP_TOOLS).toHaveLength(Object.values(ChatToolName).length);
  });
});
