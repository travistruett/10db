import { BuilderToolName, ChatGitToolName, ChatToolName } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { CHAT_MCP_TOOLS, chatProfile } from './hooks';
import { CHAT_TOOL_POLICY } from './tool-policy';

// Sessions spec §6.6: every builder tool is on a chat's server, plus set_title and the git tools; four ask the builder.

const ASKS = ['remove_task', 'retire_knowledge', 'withdraw_knowledge', 'supersede_knowledge'];

describe('the chat tool policy', () => {
  it.each(
    [
      ...Object.values(BuilderToolName),
      ChatToolName.SetTitle,
      ...Object.values(ChatGitToolName),
    ].map((name) => ({ name })),
  )('$name has its policy', ({ name }) => {
    expect(CHAT_TOOL_POLICY[name]).toBe(ASKS.includes(name) ? 'asks' : 'runs');
  });

  it('names every builder tool, set_title and the git tools, and nothing else', () => {
    expect(new Set(Object.values(ChatToolName))).toEqual(
      new Set([...Object.values(BuilderToolName), 'set_title', ...Object.values(ChatGitToolName)]),
    );
    expect(new Set(Object.keys(CHAT_TOOL_POLICY))).toEqual(new Set(Object.values(ChatToolName)));
  });

  it('asks on exactly four, and puts every one in allowedTools', () => {
    expect(
      Object.entries(CHAT_TOOL_POLICY)
        .filter(([, policy]) => policy === 'asks')
        .map(([name]) => name)
        .sort(),
    ).toEqual([...ASKS].sort());
    const allowed = chatProfile(true).allowedTools;
    for (const name of Object.values(ChatToolName)) expect(allowed).toContain(`mcp__10db__${name}`);
    expect(CHAT_MCP_TOOLS).toHaveLength(Object.values(ChatToolName).length);
  });
});
