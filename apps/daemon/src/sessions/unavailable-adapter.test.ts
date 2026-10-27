import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { createUnavailableAdapter, type SessionEvent, type SessionSpec } from './index';

describe('createUnavailableAdapter', () => {
  it('ends the session at once with the message', async () => {
    const adapter = createUnavailableAdapter('No session adapter is configured');
    const spec: SessionSpec = {
      sessionId: mintId('Session'),
      workstreamId: mintId('Workstream'),
      sequence: 1,
      cwd: '/tmp',
      prompt: 'Task: Alpha\n',
      model: 'sonnet',
      effort: 'medium',
      resumeProviderSessionId: null,
      env: {},
      account: {
        accountId: mintId('Account'),
        label: 'Claude plan',
        kind: 'claude_subscription',
        identity: null,
      },
      projectMcpServers: {},
      allowedTools: [],
      mcp: { url: 'http://127.0.0.1:1/mcp', token: 't', toolTimeoutMs: 1000 },
      preToolUse: () => ({ decision: 'allow' }),
      canUseTool: () => Promise.resolve({ behavior: 'allow' }),
    };
    const events: SessionEvent[] = [];
    for await (const event of adapter.start(spec).events) events.push(event);
    expect(events).toEqual([
      { type: 'ended', reason: 'error', message: 'No session adapter is configured' },
    ]);
  });
});
