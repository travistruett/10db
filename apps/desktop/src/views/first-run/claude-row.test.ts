import { AccountProblem, ToolCheck, type AccountIdentityDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { accountIdentityDto } from '../../test/account-fixtures';
import { claudeRow } from './claude-row';

const found = ToolCheck.parse({
  name: 'claude',
  path: '/usr/local/bin/claude',
  version: '2.1.299 (Claude Code)',
  required: true,
});
const missing = ToolCheck.parse({ name: 'claude', path: null, version: null, required: true });

function refused(problem: AccountProblem, extra: Partial<AccountIdentityDto> = {}) {
  return accountIdentityDto({
    refusal: { problem, message: `refusal: ${problem}`, seenIdentity: null },
    ...extra,
  });
}

interface Row {
  readonly name: string;
  readonly input: Parameters<typeof claudeRow>[0];
  readonly expected: ReturnType<typeof claudeRow>;
}

const rows: Row[] = [
  {
    name: 'no claude where 10db looks',
    input: { claude: missing, probing: false, identity: null, error: null },
    expected: {
      mark: 'bad',
      detail:
        'Not found in /opt/homebrew/bin, /usr/local/bin, /usr/bin, ~/.local/bin and ~/.claude/local. Install Claude Code, then recheck.',
      runsAs: null,
      canAddLogin: false,
    },
  },
  {
    name: 'a missing claude wins over a running probe',
    input: { claude: missing, probing: true, identity: null, error: null },
    expected: {
      mark: 'bad',
      detail:
        'Not found in /opt/homebrew/bin, /usr/local/bin, /usr/bin, ~/.local/bin and ~/.claude/local. Install Claude Code, then recheck.',
      runsAs: null,
      canAddLogin: false,
    },
  },
  {
    name: 'the system check has not answered yet',
    input: { claude: undefined, probing: false, identity: null, error: null },
    expected: {
      mark: 'pending',
      detail: 'Looking for Claude Code…',
      runsAs: null,
      canAddLogin: false,
    },
  },
  {
    name: 'the probe is running',
    input: { claude: found, probing: true, identity: null, error: null },
    expected: {
      mark: 'pending',
      detail: 'Starting Claude Code to read the account…',
      runsAs: null,
      canAddLogin: false,
    },
  },
  {
    name: 'the probe has not started',
    input: { claude: found, probing: false, identity: null, error: null },
    expected: {
      mark: 'pending',
      detail: 'Starting Claude Code to read the account…',
      runsAs: null,
      canAddLogin: false,
    },
  },
  {
    name: 'signed in and recorded',
    input: { claude: found, probing: false, identity: accountIdentityDto(), error: null },
    expected: {
      mark: 'ok',
      detail: 'Signed in as builder@example.com. Tasks run as this login.',
      runsAs: 'builder@example.com',
      canAddLogin: true,
    },
  },
  {
    name: 'signed in but not recorded yet counts as signed in',
    input: {
      claude: found,
      probing: false,
      identity: accountIdentityDto({
        email: 'new@example.com',
        refusal: {
          problem: AccountProblem.Unconfirmed,
          message: 'unconfirmed',
          seenIdentity: 'new@example.com',
        },
      }),
      error: null,
    },
    expected: {
      mark: 'ok',
      detail: 'Signed in as new@example.com. Tasks run as this login.',
      runsAs: 'new@example.com',
      canAddLogin: true,
    },
  },
  {
    name: 'the personal organization is hidden',
    input: {
      claude: found,
      probing: false,
      identity: accountIdentityDto({ organization: "builder@example.com's Organization" }),
      error: null,
    },
    expected: {
      mark: 'ok',
      detail: 'Signed in as builder@example.com. Tasks run as this login.',
      runsAs: 'builder@example.com',
      canAddLogin: true,
    },
  },
  {
    name: 'a real organization is shown',
    input: {
      claude: found,
      probing: false,
      identity: accountIdentityDto({ organization: 'Acme Inc' }),
      error: null,
    },
    expected: {
      mark: 'ok',
      detail: 'Signed in as builder@example.com · Acme Inc. Tasks run as this login.',
      runsAs: 'builder@example.com',
      canAddLogin: true,
    },
  },
  {
    name: 'signed in without an email on record',
    input: {
      claude: found,
      probing: false,
      identity: accountIdentityDto({ email: null }),
      error: null,
    },
    expected: {
      mark: 'ok',
      detail: 'Signed in. Tasks run as this login.',
      runsAs: null,
      canAddLogin: true,
    },
  },
  {
    name: 'signed out',
    input: {
      claude: found,
      probing: false,
      identity: refused(AccountProblem.SignedOut, { email: null }),
      error: null,
    },
    expected: { mark: 'bad', detail: 'refusal: signed_out', runsAs: null, canAddLogin: true },
  },
  {
    name: 'a refusal other than unconfirmed shows its message',
    input: {
      claude: found,
      probing: false,
      identity: refused(AccountProblem.IdentityMismatch),
      error: null,
    },
    expected: {
      mark: 'bad',
      detail: 'refusal: identity_mismatch',
      runsAs: null,
      canAddLogin: true,
    },
  },
  {
    name: 'the probe request failed',
    input: { claude: found, probing: false, identity: null, error: 'The daemon is busy.' },
    expected: { mark: 'bad', detail: 'The daemon is busy.', runsAs: null, canAddLogin: false },
  },
];

describe('claudeRow', () => {
  it.each(rows)('$name', ({ input, expected }) => {
    expect(claudeRow(input)).toEqual(expected);
  });
});
