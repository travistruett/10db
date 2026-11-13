import { mintId } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import {
  claudeCapabilities,
  createUnavailableAdapter,
  type LaneSessionSpec,
  type SessionEvent,
} from './index';
import { testPolicy } from '../../test/fixtures';

describe('createUnavailableAdapter', () => {
  it('ends the session at once with the message', async () => {
    const adapter = createUnavailableAdapter('No session adapter is configured', (a) =>
      claudeCapabilities(a.kind, null),
    );
    const spec: LaneSessionSpec = {
      sessionId: mintId('Session'),
      policy: testPolicy(),
      profile: { kind: 'lane', workstreamId: mintId('Workstream'), sequence: 1, allowedTools: [] },
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
      sandbox: null,
      mcp: { url: 'http://127.0.0.1:1/mcp', token: 't', toolTimeoutMs: 1000 },
      preToolUse: () => ({ decision: 'allow' }),
      canUseTool: () => Promise.resolve({ behavior: 'allow' }),
    };
    const events: SessionEvent[] = [];
    for await (const event of adapter.open(spec).events) events.push(event);
    expect(events).toEqual([
      { type: 'ended', reason: 'error', message: 'No session adapter is configured' },
    ]);
  });
});
