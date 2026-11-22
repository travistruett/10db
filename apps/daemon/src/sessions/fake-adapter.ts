import { AccountKind, Provider, type AccountId, type SessionId } from '@10db/contracts';
import type { AccountExpectation } from '../environment';
import { onProfile } from './agent-profile';
import { checkAccount, type SeenAccount } from './account-check';
import { capabilitiesOf, type AgentCapabilities } from './capabilities';
import { McpAuthState } from './codex-mcp-auth';
import type { FakeInterrupt, FakeObservation, FakeScriptBook, FakeSent } from './fake-script';
import {
  fakeEndedSession,
  fakeProviderSessionId,
  FakeSessionClashError,
  runFakeExploreSession,
  runFakeLaneSession,
  type FakeLaneContext,
  type FakeShapeBehaviour,
} from './fake-session';
import {
  CompletionError,
  SessionEndReason,
  type AccountLogin,
  type AccountLoginOutcome,
  type AccountProbeSpec,
  type AgentSessionSpec,
  type McpAuthSpec,
  type McpSignIn,
  type McpSignInSpec,
  type CompletionSpec,
  type ConversationReadSpec,
  type InterruptReceipt,
  type AgentAdapter,
  type ExploreSessionSpec,
  type LaneSessionSpec,
  type SessionHandle,
} from './types';
import type { TakeoverCommand, TakeoverSpec } from './takeover-command';

/** The email the fake reports for a subscription that expects none, and for an identity probe. */
const FAKE_ACCOUNT_EMAIL = 'builder@example.com';

/** A book key that scripts a chat by its first message, as `Task: ` names a task. */
const CHAT_KEY = 'Chat: ';

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
    case AccountKind.CodexSignin:
      return {
        ...NOTHING_SEEN,
        email: expect.identity ?? FAKE_ACCOUNT_EMAIL,
        subscriptionType: 'pro',
        apiProvider: 'chatgpt',
      };
    case AccountKind.OpenRouter:
      return NOTHING_SEEN;
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
  /** Every MCP sign-in started here, with a way to end it as the agent would. */
  readonly mcpSignIns: {
    readonly spec: McpSignInSpec;
    readonly end: (outcome: AccountLoginOutcome) => void;
    reopened: number;
    cancelled: boolean;
  }[] = [];
  /** What `mcpAuthStatus` answers for a server by name; a name not set reads as not signed in. */
  readonly mcpAuth: Record<string, McpAuthState> = {};
  /** When true, `mcpAuthStatus` never answers, as a Codex that doesn't. */
  mcpAuthHangs = false;
  /** When set, `mcpAuthStatus` rejects with it, as a Codex that can't start. */
  mcpAuthError: Error | null = null;
  /** When set, `mcpAuthStatus` answers what the servers read as it was called, once this settles. */
  mcpAuthGate: Promise<void> | null = null;
  /** When set, `startMcpSignIn` answers once this settles. */
  mcpSignInGate: Promise<void> | null = null;
  /** Every `mcpAuthStatus` call. */
  readonly mcpAuthReads: McpAuthSpec[] = [];
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

  /** What the fake says it can do, over the agent's own: a test stages another agent's row. */
  capabilityOverrides: Partial<AgentCapabilities> = {};

  capabilities(
    account: Pick<AccountExpectation, 'kind' | 'harness'>,
    model: string | null,
  ): AgentCapabilities {
    return { ...capabilitiesOf(account, model), ...this.capabilityOverrides };
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

  /** Every takeover command asked for, in order. */
  readonly takeovers: Omit<TakeoverSpec, 'binary'>[] = [];

  /** A command that runs `/usr/bin/true` in the folder, so a terminal that opens it finishes at once. */
  takeoverCommand(spec: Omit<TakeoverSpec, 'binary'>): TakeoverCommand {
    this.takeovers.push(spec);
    return {
      cwd: spec.cwd,
      unset: spec.launch.unset,
      unsetPrefixes: spec.launch.unsetPrefixes,
      set: spec.launch.set,
      keychain: spec.launch.keychain,
      sources: [],
      argv: ['/usr/bin/true'],
    };
  }

  takeoverNotes(): string[] {
    return [];
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
        spec.harness === Provider.Codex
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

  async startMcpSignIn(spec: McpSignInSpec): Promise<McpSignIn> {
    await this.mcpSignInGate;
    let end: (outcome: AccountLoginOutcome) => void = () => undefined;
    const outcome = new Promise<AccountLoginOutcome>((resolve) => {
      end = resolve;
    });
    const record = { spec, end, reopened: 0, cancelled: false };
    this.mcpSignIns.push(record);
    return {
      outcome,
      reopen() {
        record.reopened += 1;
        return Promise.resolve();
      },
      cancel() {
        record.cancelled = true;
        end({ ok: false, message: 'The sign-in was cancelled.' });
        return Promise.resolve();
      },
    };
  }

  /** Ends the latest sign-in of `name` as the browser would: a success also reads as signed in from then on. */
  completeMcpSignIn(name: string, ok: boolean): void {
    const record = this.mcpSignIns.findLast((signIn) => signIn.spec.name === name);
    if (record === undefined) return;
    if (ok) {
      this.mcpAuth[name] = McpAuthState.SignedIn;
      record.end({ ok: true });
    } else record.end({ ok: false, message: "The sign-in didn't finish. Try Sign in again." });
  }

  async mcpAuthStatus(spec: McpAuthSpec): Promise<Readonly<Record<string, McpAuthState>>> {
    this.mcpAuthReads.push(spec);
    if (this.mcpAuthError !== null) throw this.mcpAuthError;
    if (this.mcpAuthHangs) return new Promise(() => undefined);
    const read = Object.fromEntries(
      Object.keys(spec.servers).map((name) => [
        name,
        this.mcpAuth[name] ?? McpAuthState.NotSignedIn,
      ]),
    );
    await this.mcpAuthGate;
    return read;
  }

  /** What each Shape session started here ran with, and what it was sent after its first message. */
  readonly shapeSessions: {
    readonly spec: ExploreSessionSpec;
    readonly sent: string[];
    /** The client uuid each message after the first went under, null for none. */
    readonly uuids: (string | null)[];
    /** Every model the session was switched to, in order. */
    readonly models: string[];
    readonly handle: SessionHandle;
  }[] = [];
  /** How a Shape session answers a message; the default writes a short reply. */
  shapeBehaviour: FakeShapeBehaviour = () => Promise.resolve({ text: 'Understood.' });
  /**
   * When set, a Shape session's stop waits for it before the session ends, as a real process can
   * take seconds to close after it is asked to.
   */
  shapeStopGate: Promise<void> | null = null;
  /** When set, a Shape session reports `started` only once it resolves. */
  shapeStartGate: Promise<void> | null = null;
  /** What switching a Shape session's model answers; it switches by default. */
  shapeModelSwitch: (model: string) => Promise<void> = () => Promise.resolve();
  /**
   * What a Shape session's interrupt answers, from the uuids of the messages it holds that no turn has
   * begun: by default none, as a Claude Code without `interrupt_receipt_v1`.
   */
  shapeInterruptReceipt: (
    queued: readonly string[],
  ) => InterruptReceipt | Promise<InterruptReceipt> = () => null;
  /** The same for a lane session: its stop waits for it before the session ends. */
  laneStopGate: Promise<void> | null = null;

  /**
   * Why a Shape session ends before it starts, or null when it starts: a test stands for an agent
   * session that can no longer be resumed.
   */
  shapeStartFailure: (
    spec: ExploreSessionSpec,
  ) => { readonly reason: SessionEndReason; readonly message: string } | null = () => null;

  /** The sessions each scripted chat has opened, for the sequence its next one runs. */
  private readonly chatSessions = new Map<string, number>();

  /** The book key each scripted chat session ran, so a session resumed from it runs the key's next script. */
  private readonly chatKeyOfSession = new Map<string, string>();

  /**
   * The book's `Chat: <text>` key a chat's prompt matches: one of its message lines (`[m:<id>] …`)
   * reads `<text>`, or starts with it and a space, as a line with a mention after it does.
   */
  private chatKey(prompt: string): string | null {
    const lines = prompt.split('\n').map((line) => line.replace(/^\[m:[^\]]+\] /, ''));
    return (
      Object.keys(this.book).find((key) => {
        if (!key.startsWith(CHAT_KEY)) return false;
        const text = key.slice(CHAT_KEY.length);
        return lines.some((line) => line === text || line.startsWith(`${text} `));
      }) ?? null
    );
  }

  private openExplore(spec: ExploreSessionSpec, providerSessionId: string): SessionHandle {
    const resumed =
      spec.resumeProviderSessionId === null
        ? undefined
        : this.chatKeyOfSession.get(spec.resumeProviderSessionId);
    const chat = this.chatKey(spec.prompt) ?? resumed ?? null;
    if (chat !== null) return this.openScriptedChat(spec, providerSessionId, chat);
    const refusal = checkAccount(spec.account, expectedSeen(spec.account));
    const failure = refusal === null ? this.shapeStartFailure(spec) : null;
    const sent: string[] = [];
    const uuids: (string | null)[] = [];
    const models: string[] = [];
    const inner = refusal
      ? fakeEndedSession({
          type: 'ended',
          reason: SessionEndReason.AccountRefused,
          message: `${refusal.message}. No message was sent.`,
        })
      : failure !== null
        ? fakeEndedSession({ type: 'ended', reason: failure.reason, message: failure.message })
        : runFakeExploreSession(
            spec,
            (turn) => this.shapeBehaviour(turn),
            providerSessionId,
            this.claim(providerSessionId),
            (queued) => this.shapeInterruptReceipt(queued),
            () => this.shapeStartGate,
          );
    const handle: SessionHandle = {
      events: inner.events,
      send: (text, images, uuid) => {
        sent.push(text);
        uuids.push(uuid ?? null);
        inner.send(text, images, uuid);
      },
      interrupt: () => inner.interrupt(),
      stop: async () => {
        if (this.shapeStopGate !== null) await this.shapeStopGate;
        await inner.stop();
      },
      setModel: async (model) => {
        await this.shapeModelSwitch(model);
        models.push(model);
        await inner.setModel(model);
      },
    };
    this.shapeSessions.push({ spec, sent, uuids, models, handle });
    return handle;
  }

  /** A chat whose prompt the book scripts runs its steps as a lane's do, one script per session. */
  private openScriptedChat(
    spec: ExploreSessionSpec,
    providerSessionId: string,
    key: string,
  ): SessionHandle {
    const sequence = (this.chatSessions.get(key) ?? 0) + 1;
    this.chatSessions.set(key, sequence);
    this.chatKeyOfSession.set(providerSessionId, key);
    const sent: string[] = [];
    const uuids: (string | null)[] = [];
    const inner = runFakeLaneSession(
      { ...spec, profile: { sequence, allowedTools: spec.profile.allowedTools } },
      this.scriptContext(providerSessionId, key, this.book[key]?.[sequence - 1], undefined),
    );
    const handle: SessionHandle = {
      ...inner,
      send: (text, images, uuid) => {
        sent.push(text);
        uuids.push(uuid ?? null);
        inner.send(text, images, uuid);
      },
    };
    this.shapeSessions.push({ spec, sent, uuids, models: [], handle });
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
    return runFakeLaneSession(
      spec,
      this.scriptContext(
        providerSessionId,
        title,
        this.book[title]?.[spec.profile.sequence - 1],
        reportedModel,
      ),
    );
  }

  /** What a scripted session, a lane's or a chat's, is run with. */
  private scriptContext(
    providerSessionId: string,
    title: string,
    steps: FakeLaneContext['steps'],
    reportedModel: string | undefined,
  ): FakeLaneContext {
    return {
      providerSessionId,
      onEnded: this.claim(providerSessionId),
      title,
      steps,
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
    };
  }
}
