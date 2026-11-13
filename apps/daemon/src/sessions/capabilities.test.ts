import { AgentCapabilitiesDto, SUPPORTED_ACCOUNT_KINDS } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { capabilitiesOf, claudeCapabilities, codexCapabilities } from './capabilities';
import { FakeAdapter } from './fake-adapter';
import { createRoutedAdapter } from './routed-adapter';
import { createUnavailableAdapter } from './unavailable-adapter';
import type { AgentAdapter } from './types';

const CLAUDE = {
  harness: 'claude',
  label: 'Claude Code',
  steer: 'inject',
  receipts: true,
  readBack: false,
  images: ['png', 'jpeg', 'webp'],
  slashCommands: true,
  plan: true,
  reasoning: true,
  subagents: true,
  modelSwitch: 'next_turn',
  takeover: true,
} as const;
const CODEX = {
  ...CLAUDE,
  harness: 'codex',
  label: 'Codex',
  readBack: true,
  subagents: false,
  costUsd: false,
} as const;

describe('capabilities', () => {
  it.each([
    ['claude_subscription', { ...CLAUDE, costUsd: false, judge: 'native' }],
    ['anthropic_api_key', { ...CLAUDE, costUsd: true, judge: 'native' }],
    ['bedrock', { ...CLAUDE, costUsd: true, judge: 'native' }],
    ['gateway', { ...CLAUDE, costUsd: true, judge: 'rules' }],
    ['codex_signin', { ...CODEX, judge: 'rules' }],
  ] as const)('%s runs on an agent that can do what spec §5.3 says', (kind, expected) => {
    expect(capabilitiesOf(kind)).toEqual(expected);
    expect(AgentCapabilitiesDto.parse(capabilitiesOf(kind))).toEqual(expected);
  });

  // Delivery rule 3 (spec §6.2): a message injected mid-turn counts as delivered only by a receipt.
  it.each(
    SUPPORTED_ACCOUNT_KINDS.flatMap((kind) => [
      [`claude on ${kind}`, claudeCapabilities(kind)] as const,
      [`codex on ${kind}`, codexCapabilities(kind)] as const,
    ]),
  )('%s: an adapter that injects reports receipts', (_name, caps) => {
    expect(caps.steer !== 'inject' || caps.receipts).toBe(true);
  });

  const ADAPTERS: readonly (readonly [string, AgentAdapter])[] = [
    ['the fake', new FakeAdapter({})],
    ['an unavailable claude', createUnavailableAdapter('x', (a) => claudeCapabilities(a.kind))],
    [
      'the routed pair',
      createRoutedAdapter({
        claude: createUnavailableAdapter('x', (a) => claudeCapabilities(a.kind)),
        codex: createUnavailableAdapter('x', (a) => codexCapabilities(a.kind)),
      }),
    ],
  ];
  it.each(
    ADAPTERS.flatMap(([name, adapter]) =>
      SUPPORTED_ACCOUNT_KINDS.map((kind) => [`${name} on ${kind}`, adapter, kind] as const),
    ),
  )('%s: an adapter that injects reports receipts', (_name, adapter, kind) => {
    const caps = adapter.capabilities({ kind }, null);
    expect(caps.steer !== 'inject' || caps.receipts).toBe(true);
  });
});
