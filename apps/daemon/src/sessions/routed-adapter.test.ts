import { AccountKind, mintId, type SupportedAccountKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { createChannel } from './channel';
import { createRoutedAdapter } from './routed-adapter';
import type {
  SessionAdapter,
  SessionEvent,
  SessionHandle,
  SessionSpec,
  ShapeSessionHandle,
  ShapeSessionSpec,
} from './types';

const ended = () => {
  const events = createChannel<SessionEvent>();
  events.end();
  return events;
};

/** Records which of its methods ran, in order, and answers each with its own name. */
function recording(name: string): SessionAdapter & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    complete: () => {
      calls.push('complete');
      return Promise.resolve(name);
    },
    probeAccount: () => {
      calls.push('probeAccount');
      return Promise.resolve({
        email: name,
        organization: undefined,
        subscriptionType: undefined,
        tokenSource: undefined,
        apiKeySource: undefined,
        apiProvider: undefined,
      });
    },
    start: () => {
      calls.push('start');
      return {
        events: ended(),
        send: () => undefined,
        stop: () => Promise.resolve(),
      } satisfies SessionHandle;
    },
    startShape: () => {
      calls.push('startShape');
      return {
        events: ended(),
        send: () => undefined,
        interrupt: () => Promise.resolve(),
        stop: () => Promise.resolve(),
      } satisfies ShapeSessionHandle;
    },
  };
}

const account = (kind: SupportedAccountKind) => ({
  accountId: mintId('Account'),
  label: 'A',
  kind,
  identity: null,
});

/** Only the account matters to routing; the rest of a spec is the adapter's. */
const asSession = (kind: SupportedAccountKind) => ({ account: account(kind) }) as SessionSpec; // routing reads only `account`
const asShape = (kind: SupportedAccountKind) => ({ account: account(kind) }) as ShapeSessionSpec; // routing reads only `account`

const CLAUDE_KINDS = [
  AccountKind.ClaudeSubscription,
  AccountKind.Bedrock,
  AccountKind.Gateway,
  AccountKind.AnthropicApiKey,
] as const;

const METHODS = ['start', 'startShape', 'complete', 'probeAccount'] as const;

async function callAll(adapter: SessionAdapter, kind: SupportedAccountKind): Promise<void> {
  adapter.start(asSession(kind));
  adapter.startShape(asShape(kind));
  await adapter.complete({ cwd: '/d', prompt: 'q', model: 'm', env: {}, account: account(kind) });
  await adapter.probeAccount({ cwd: '/d', env: {}, kind });
}

describe('createRoutedAdapter', () => {
  it.each(CLAUDE_KINDS)('sends %s to Claude', async (kind) => {
    const claude = recording('claude');
    const codex = recording('codex');
    await callAll(createRoutedAdapter({ claude, codex }), kind);
    expect(claude.calls.sort()).toEqual([...METHODS].sort());
    expect(codex.calls).toEqual([]);
  });

  it('sends codex_signin to Codex', async () => {
    const claude = recording('claude');
    const codex = recording('codex');
    const adapter = createRoutedAdapter({ claude, codex });
    await callAll(adapter, AccountKind.CodexSignin);
    expect(codex.calls.sort()).toEqual([...METHODS].sort());
    expect(claude.calls).toEqual([]);
    const probed = await adapter.probeAccount({
      cwd: '/d',
      env: {},
      kind: AccountKind.CodexSignin,
    });
    expect(probed.email).toBe('codex');
  });
});
