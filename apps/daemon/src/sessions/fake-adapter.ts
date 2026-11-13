import { AccountKind, Provider, providerOf, type AccountId, type SessionId } from '@10db/contracts';
import type { AccountExpectation } from '../environment';
import { onProfile } from './agent-profile';
import { checkAccount, type SeenAccount } from './account-check';
import { capabilitiesOf, type AgentCapabilities } from './capabilities';
import type { FakeInterrupt, FakeObservation, FakeScriptBook, FakeSent } from './fake-script';
import {
  fakeEndedSession,
  fakeProviderSessionId,
  FakeSessionClashError,
  runFakeExploreSession,
  runFakeLaneSession,
  type FakeShapeBehaviour,
} from './fake-session';
import {
  CompletionError,
  SessionEndReason,
  type AccountLogin,
  type AccountLoginOutcome,
  type AccountProbeSpec,
  type AgentSessionSpec,
  type CompletionSpec,
  type ConversationReadSpec,
  type InterruptReceipt,
  type AgentAdapter,
  type ExploreSessionSpec,
  type LaneSessionSpec,
  type SessionHandle,
} from './types';

/** The email the fake reports for a subscription that expects none, and for an identity probe. */
export const FAKE_ACCOUNT_EMAIL = 'builder@example.com';

const NOTHING_SEEN: SeenAccount = {
  email: undefined,
  organization: undefined,
  subscriptionType: undefined,
  tokenSource: undefined,
  apiKeySource: undefined,
  apiProvider: undefined,
};

/** What a well-configured session of each kind reports: exactly what it expects. */
function expectedSeen(expect: AccountExpectation): SeenAccount {
  switch (expect.kind) {
    case AccountKind.ClaudeSubscription:
      return {
        ...NOTHING_SEEN,
        email: expect.identity ?? FAKE_ACCOUNT_EMAIL,
        subscriptionType: 'Claude Max',
        apiProvider: 'firstParty',
        apiKeySource: 'none',
      };
    case AccountKind.AnthropicApiKey:
      return {
        ...NOTHING_SEEN,
        apiKeySource: 'ANTHROPIC_API_KEY',
        apiProvider: 'firstParty',
        organization: expect.identity ?? undefined,
      };
    case AccountKind.Bedrock:
      return {
        ...NOTHING_SEEN,
        apiProvider: 'bedrock',
        organization: expect.identity ?? undefined,
      };
    case AccountKind.Gateway:
      return {
        ...NOTHING_SEEN,
        apiProvider: 'firstParty',
        apiKeySource: 'none',
        tokenSource: 'ANTHROPIC_AUTH_TOKEN',
      };
    case AccountKind.CodexSignin:
      return {
        ...NOTHING_SEEN,
        email: expect.identity ?? FAKE_ACCOUNT_EMAIL,
        subscriptionType: 'pro',
        apiProvider: 'chatgpt',
      };
  }
}

/** Stands in for Claude Code at the adapter boundary; scripts drive every event. */
export class FakeAdapter implements AgentAdapter {
  readonly observations: FakeObservation[] = [];
  /** Every message the runner sent a session, in order, with how many images and the uuid it carried. */
  readonly sent: FakeSent[] = [];
  readonly prompts: {
    sessionId: SessionId;
    sequence: number;
    title: string;
    prompt: string;
    /** The prompt's client uuid, and how many images went with it. */
    promptUuid: string | null;
    images: number;
    resume: string | null;
    accountId: AccountId;
  }[] = [];
  /** Every lane session's interrupt, in order, with what it answered. */
  readonly interrupts: FakeInterrupt[] = [];
  /**
   * The client uuids each conversation has been sent, by provider session id. Claude Code runs no
   * turn for a user message under a uuid its transcript already holds, a resumed one's included: it
   * acknowledges it and drops it, as the live test saw. So does the fake.
   */
  private readonly transcripts = new Map<string, Set<string>>();
  /** The client uuids each conversation's turns took, by provider session id, as a Codex thread keeps them. */
  private readonly taken = new Map<string, string[]>();
  /** Every conversation read back, in order. */
  readonly reads: ConversationReadSpec[] = [];
  /**
   * What reading a conversation back answers: by default the client uuids its turns took here, as a
   * Codex thread keeps them. A test sets it to stand for a thread a daemon that died left behind, or
   * one that can't be read.
   */
  readBack: (spec: ConversationReadSpec) => Promise<readonly string[]> = (spec) =>
    Promise.resolve([...(this.taken.get(spec.providerSessionId) ?? [])]);
  /**
   * What a lane session's interrupt answers, from the uuids of the messages no turn has taken yet: by
   * default all of them as still queued, as a Claude Code that advertises `interrupt_receipt_v1` does;
   * null stands for one that answers nothing.
   */
  /**
   * Whether a lane session's interrupt ends the session after its receipt, as a Codex session does
   * when Codex never reports the interrupted turn ended.
   */
  interruptEndsSession = false;
  interruptReceipt: (untaken: readonly string[]) => InterruptReceipt = (untaken) => ({
    stillQueued: [...untaken],
  });

  /** What a session reports for its account, over what it expects; tests set it to stage a mismatch. */
  seen: (spec: LaneSessionSpec) => Partial<SeenAccount> & { readonly model?: string } = () => ({});
  /** What an identity probe reports. */
  probeSeen: SeenAccount = {
    ...NOTHING_SEEN,
    email: FAKE_ACCOUNT_EMAIL,
    subscriptionType: 'Claude Max',
    apiProvider: 'firstParty',
    apiKeySource: 'none',
  };
  readonly probes: AccountProbeSpec[] = [];
  /** Every browser sign-in started here, with a way to end it as the agent would. */
  readonly logins: {
    readonly spec: AccountProbeSpec;
    readonly end: (outcome: AccountLoginOutcome) => void;
    cancelled: boolean;
  }[] = [];
  /** Every question put to the model by `complete`. */
  readonly completions: CompletionSpec[] = [];
  /** What the model answers; the default has none, so a caller falls back to what it can do without. */
  answer: (ask: CompletionSpec) => Promise<string> = () =>
    Promise.reject(new CompletionError('The fake adapter has no model to ask.'));

  /** The agent sessions a handle is open on, until that handle's `ended`. */
  private readonly openIds = new Set<string>();
  private readonly book: FakeScriptBook;
  /** The names `signal` was called with, and the sessions waiting for one. */
  private readonly signalled = new Set<string>();
  private signalWaiters: (() => void)[] = [];

  constructor(book: FakeScriptBook) {
    this.book = book;
  }

  /** Marks the agent session open and returns what releases it when the session ends. */
  private claim(providerSessionId: string): () => void {
    this.openIds.add(providerSessionId);
    return () => {
      this.openIds.delete(providerSessionId);
    };
  }

  /** Lets every session waiting at `await_signal` for `name` go on, and any that reaches it later. */
  signal(name: string): void {
    this.signalled.add(name);
    const waiters = this.signalWaiters;
    this.signalWaiters = [];
    for (const wake of waiters) wake();
  }

  capabilities(account: Pick<AccountExpectation, 'kind'>): AgentCapabilities {
    return capabilitiesOf(account.kind);
  }

  /**
   * Throws a `FakeSessionClashError` when a handle is still open on the agent session the spec runs
   * under, before anything is recorded: a second writer on one agent session is a bug in the caller.
   */
  open(spec: AgentSessionSpec): SessionHandle {
    const id = fakeProviderSessionId(
      spec,
      onProfile(spec, {
        lane: (lane) => `fake-${lane.sessionId}`,
        explore: () => `fake-shape-${String(this.shapeSessions.length + 1)}`,
      }),
    );
    if (this.openIds.has(id)) throw new FakeSessionClashError(id);
    return onProfile(spec, {
      lane: (lane) => this.openLane(lane, id),
      explore: (explore) => this.openExplore(explore, id),
    });
  }

  complete(ask: CompletionSpec): Promise<string> {
    this.completions.push(ask);
    return this.answer(ask);
  }

  readClientUuids(spec: ConversationReadSpec): Promise<readonly string[]> {
    this.reads.push(spec);
    return this.readBack(spec);
  }

  probeAccount(probe: AccountProbeSpec): Promise<SeenAccount> {
    this.probes.push(probe);
    return Promise.resolve(this.probeSeen);
  }

  startLogin(spec: AccountProbeSpec): Promise<AccountLogin> {
    let end: (outcome: AccountLoginOutcome) => void = () => undefined;
    const outcome = new Promise<AccountLoginOutcome>((resolve) => {
      end = resolve;
    });
    const record = { spec, end, cancelled: false };
    this.logins.push(record);
    return Promise.resolve({
      // Codex names the page to open; Claude Code opens the browser itself.
      authUrl:
        providerOf(spec.kind) === Provider.Codex
          ? 'https://auth.openai.com/oauth/authorize?state=fake'
          : null,
      outcome,
      cancel() {
        record.cancelled = true;
        end({ ok: false, message: 'The sign-in was cancelled.' });
        return Promise.resolve();
      },
    });
  }

  /** What each Shape session started here ran with, and what it was sent after its first message. */
  readonly shapeSessions: {
    readonly spec: ExploreSessionSpec;
    readonly sent: string[];
    readonly handle: SessionHandle;
  }[] = [];
  /** How a Shape session answers a message; the default writes a short reply. */
  shapeBehaviour: FakeShapeBehaviour = () => Promise.resolve({ text: 'Understood.' });
  /**
   * When set, a Shape session's stop waits for it before the session ends, as a real process can
   * take seconds to close after it is asked to.
   */
  shapeStopGate: Promise<void> | null = null;
  /** The same for a lane session: its stop waits for it before the session ends. */
  laneStopGate: Promise<void> | null = null;

  private openExplore(spec: ExploreSessionSpec, providerSessionId: string): SessionHandle {
    const refusal = checkAccount(spec.account, expectedSeen(spec.account));
    const sent: string[] = [];
    const inner = refusal
      ? fakeEndedSession({
          type: 'ended',
          reason: SessionEndReason.AccountRefused,
          message: `${refusal.message}. No message was sent.`,
        })
      : runFakeExploreSession(
          spec,
          (turn) => this.shapeBehaviour(turn),
          providerSessionId,
          this.claim(providerSessionId),
        );
    const handle: SessionHandle = {
      events: inner.events,
      send: (text, images) => {
        sent.push(text);
        inner.send(text, images);
      },
      interrupt: () => inner.interrupt(),
      stop: async () => {
        if (this.shapeStopGate !== null) await this.shapeStopGate;
        await inner.stop();
      },
    };
    this.shapeSessions.push({ spec, sent, handle });
    return handle;
  }

  private openLane(spec: LaneSessionSpec, providerSessionId: string): SessionHandle {
    const { model: reportedModel, ...override } = this.seen(spec);
    const refusal = checkAccount(spec.account, { ...expectedSeen(spec.account), ...override });
    if (refusal)
      return fakeEndedSession({
        type: 'ended',
        reason: SessionEndReason.AccountRefused,
        message: `${refusal.message}. No prompt was sent.`,
        refusal,
      });
    const title = Object.keys(this.book).find((t) => spec.prompt.includes(`Task: ${t}\n`)) ?? '';
    this.prompts.push({
      sessionId: spec.sessionId,
      sequence: spec.profile.sequence,
      title,
      prompt: spec.prompt,
      promptUuid: spec.promptUuid ?? null,
      images: spec.images?.length ?? 0,
      resume: spec.resumeProviderSessionId,
      accountId: spec.account.accountId,
    });
    return runFakeLaneSession(spec, {
      providerSessionId,
      onEnded: this.claim(providerSessionId),
      title,
      steps: this.book[title]?.[spec.profile.sequence - 1],
      reportedModel,
      sent: this.sent,
      observations: this.observations,
      interrupts: this.interrupts,
      transcript: (id) => {
        const transcript = this.transcripts.get(id) ?? new Set<string>();
        this.transcripts.set(id, transcript);
        return transcript;
      },
      taken: (id) => {
        const taken = this.taken.get(id) ?? [];
        this.taken.set(id, taken);
        return taken;
      },
      waitForSignal: async (name, untilStopped) => {
        while (!this.signalled.has(name)) {
          const woke = await Promise.race([
            new Promise<'signal'>((r) => {
              this.signalWaiters.push(() => {
                r('signal');
              });
            }),
            untilStopped,
          ]);
          if (woke === 'stopped') return 'stopped';
        }
        return 'signal';
      },
      interruptReceipt: (untaken) => this.interruptReceipt(untaken),
      interruptEndsSession: () => this.interruptEndsSession,
      stopGate: () => this.laneStopGate,
    });
  }
}
