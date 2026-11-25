import { describe, expect, it } from 'vitest';
import {
  AccountId,
  LinearVia,
  type ToolCallStatus,
  type LinearSignInRowDto,
  type ToolCallView,
} from '@10db/contracts';
import { accountRunStart, checkSaysSignedOut, reachOutcome } from './reporter-reach';

const CLAUDE = 'mcp__linear__';
const CODEX = 'mcp__linear_app__';

const signIn = (over: Partial<LinearSignInRowDto> = {}): LinearSignInRowDto => ({
  accountId: AccountId.parse('acc_0193a5b0-0000-7000-8000-000000000001'),
  accountLabel: 'Travis Personal ChatGPT',
  via: LinearVia.Server,
  signedIn: null,
  note: null,
  serverKey: null,
  unchecked: false,
  ...over,
});

const mcp = (
  server: string,
  tool: string,
  status: ToolCallStatus,
  over: { error?: string; resultTail?: string } = {},
): ToolCallView => ({
  id: `${server}-${tool}-${status}`,
  harnessTool: `${server}.${tool}`,
  status,
  title: tool,
  startedAt: '2026-11-25T20:46:00.000Z',
  durationMs: 10,
  parentId: null,
  refusal: null,
  deniedBy: null,
  limit: null,
  soft: null,
  kind: 'mcp',
  server,
  tool,
  argumentsPreview: '{}',
  resultTail: over.resultTail ?? null,
  error: over.error ?? null,
});

const base = {
  reachedLinear: false,
  linearPrefixes: [CLAUDE],
  signIn: signIn(),
  runCalls: [] as ToolCallView[],
  earlierCalls: [] as ToolCallView[],
};

describe('whether a reporter run that posted nothing was kept from Linear by its sign-in', () => {
  it.each([
    ['a Linear call that answered', { runCalls: [mcp('linear', 'get_issue', 'done')] }, 'reached'],
    [
      'an allowed call that failed on something other than its sign-in',
      {
        reachedLinear: true,
        runCalls: [mcp('linear', 'get_issue', 'failed', { error: 'timeout' })],
      },
      'reached',
    ],
    [
      'a Linear call that failed with an auth error',
      {
        reachedLinear: true,
        runCalls: [mcp('linear', 'get_issue', 'failed', { error: 'HTTP 401 Unauthorized' })],
      },
      'sign_in',
    ],
    [
      'a Codex call on a server name mcpToolPrefix makes safe, failing as unauthenticated',
      {
        linearPrefixes: [CODEX],
        runCalls: [mcp('linear.app', 'save_comment', 'failed', { resultTail: 'unauthenticated' })],
      },
      'sign_in',
    ],
    [
      'a check that says the server is signed out',
      { signIn: signIn({ signedIn: false }) },
      'sign_in',
    ],
    [
      'a checked account with no Linear',
      { signIn: signIn({ via: LinearVia.None, signedIn: null }) },
      'sign_in',
    ],
    ['a session with no Linear server', { linearPrefixes: [] }, 'sign_in'],
    [
      'a check that says signed in',
      { signIn: signIn({ signedIn: true }) },
      { kind: 'retry', evidence: 'signed_in' },
    ],
    [
      'Linear answered earlier in the conversation',
      { earlierCalls: [mcp('linear', 'list_comments', 'done')] },
      { kind: 'retry', evidence: 'answered' },
    ],
    [
      'an earlier call on a server that is not Linear',
      { earlierCalls: [mcp('github', 'get_issue', 'done')] },
      'sign_in',
    ],
    [
      'an earlier Linear call that failed',
      { earlierCalls: [mcp('linear', 'get_issue', 'failed', { error: 'boom' })] },
      'sign_in',
    ],
    [
      'an unchecked account whose check reads nothing, with no earlier answer',
      { signIn: signIn({ via: LinearVia.None, unchecked: true }) },
      'sign_in',
    ],
    ['no sign-in row at all and no evidence', { signIn: null }, 'sign_in'],
    [
      'a signed-out check outweighs an earlier answer',
      { signIn: signIn({ signedIn: false }), earlierCalls: [mcp('linear', 'get_issue', 'done')] },
      'sign_in',
    ],
  ])('%s', (_name, over, expected) => {
    const outcome = reachOutcome({ ...base, ...over });
    expect(outcome).toEqual(typeof expected === 'string' ? { kind: expected } : expected);
  });

  it('reads a check as signed out only when it was checked or its server says so', () => {
    expect(checkSaysSignedOut(signIn({ via: LinearVia.None }))).toBe(true);
    expect(checkSaysSignedOut(signIn({ via: LinearVia.None, unchecked: true }))).toBe(false);
    expect(checkSaysSignedOut(signIn({ signedIn: false }))).toBe(true);
    expect(checkSaysSignedOut(signIn({ signedIn: true }))).toBe(false);
    expect(checkSaysSignedOut(signIn({ signedIn: null }))).toBe(false);
    expect(checkSaysSignedOut(null)).toBe(false);
  });

  it("counts earlier answers only from the account's own unbroken run of newest sessions", () => {
    const other = AccountId.parse('acc_0193a5b0-0000-7000-8000-000000000002');
    const own = signIn().accountId;
    const session = (accountId: AccountId, minute: number) => ({
      accountId,
      startedAt: `2026-11-25T20:${String(minute)}:00.000Z`,
    });
    // Newest first: the project moved from `other` to `own` between minutes 30 and 40.
    const moved = [session(own, 50), session(own, 40), session(other, 30), session(own, 20)];
    expect(accountRunStart(moved, own)).toBe('2026-11-25T20:40:00.000Z');
    // The newest session is another account's: nothing earlier is this account's answer.
    expect(accountRunStart(moved, other)).toBeNull();
    expect(accountRunStart([], own)).toBeNull();
  });
});
