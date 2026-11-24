import { createHash } from 'node:crypto';
import {
  ConflictError,
  InboxKind,
  InboxState,
  InvalidError,
  RoutedBy,
  SendFailure,
  contactIn,
  isParkChoice,
  type AskSomeoneInput,
  type InboxItemDto,
  type InboxItemId,
  type ProjectId,
  type OutboundHit,
  type PersonDto,
  type SendInput,
  type StakeholderSendDto,
} from '@10db/contracts';
import {
  BUILDER_HANDLE,
  COPY_FOR_KEY,
  SEED_BUILDER_NAME,
  closeSend,
  dropDraft,
  getInboxItem,
  getPerson,
  insertDraft,
  keepWaiting,
  latestThreadFor,
  listRoutingRules,
  markSending,
  markSent,
  newThreadsSince,
  sendForCard,
  sendingSends,
  sendSummary,
  sendThreadsOf,
  setSendChannel,
  setDmChannel,
  setHeldBy,
  setInboxRecipients,
  setRoutingRules,
  targetTaskIds,
  updateDraft,
  updateInboxItem,
  type DbReader,
  type WriteContext,
} from '@10db/db';
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import type { Logger } from '../log';
import { SlackError, tsMillis, type SlackClient, type SlackMessage } from '../slack';
import { closingLine, type ClosingReason } from './closing-lines';
import type { SlackClients } from './slack-clients';
import { readSlackWorkspaces } from './slack-workspaces';
import { draftContext, draftFor, previewDraft } from './drafts';
import { OPTION_LETTERS } from './letters';
import { scanOutbound } from './outbound-scan';
import { neutralizeAngles } from './escape';
import { blocksOf } from './slack-text';
import { failSendsToBuilder } from './send-returns';
import { holdFor } from './send-holds';

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far before a send started a search for its post begins, for clocks that differ a little. */
const SEARCH_SKEW_SECONDS = 60;
/** Slack failures that say the connection is down, not that Slack refused: the post may or may not have landed. */
const TRANSPORT = /^(?:unreachable|timeout|ratelimited|bad_reply|http_5\d\d)$/;
const SEND_METADATA = 'tendb_send';

export interface SendsDeps {
  readonly state: StateStore;
  /** Null when TENDB_SLACK=off: every draft stays as it is. */
  readonly slack: SlackClients | null;
  readonly clock: Clock;
  readonly log: Logger;
  /** Parks the sessions waiting on a card that moved to someone else (`Runner.parkFor`). */
  readonly parkFor?: (id: InboxItemId) => void;
  /** Whether a workspace's bot token is stored; Send is a 409 with the draft kept when it is not. */
  readonly hasToken?: (teamId: string) => Promise<boolean>;
  /** The effective binding (`projectSlack`): what a draft is made in; null keeps drafts in the Inbox. */
  readonly slackFor: (projectId: ProjectId) => string | null;
  /** The stored binding (`boundTeam`): a reserved send in another team is taken back, never posted. */
  readonly boundTo: (projectId: ProjectId) => string | null;
}

export const SLACK_OFF_FOR_PROJECT = 'Slack is off for this project';

export interface StakeholderSends {
  /** A fresh draft goes out at once when nothing holds it, else it is held for the builder. */
  afterDraft(cardId: InboxItemId): Promise<void>;
  send(cardId: InboxItemId, input: SendInput): Promise<StakeholderSendDto>;
  /** Reroutes the card to the people chosen and drafts for them; sending waits on review as usual. */
  askSomeone(cardId: InboxItemId, input: AskSomeoneInput): void;
  takeBack(cardId: InboxItemId): Promise<void>;
  /** The builder keeps waiting on a card that came back: both timers start again from now. */
  keepWaiting(cardId: InboxItemId): void;
  /** Sends of this workspace that were mid-flight: found posts are recorded, the rest posted. */
  recoverSending(teamId: string): Promise<void>;
  /** The closing line a card settled by the builder is owed in a conversation, or null when it is not settled. */
  closingTextFor(cardId: InboxItemId): string | null;
  /** A card changed: closes its send, and says so in the thread, when the builder settled it. */
  onCardChanged(card: InboxItemDto): Promise<void>;
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const slackCode = (error: unknown): string => (error instanceof SlackError ? error.code : 'error');

/** A Slack timestamp (seconds, six decimals) a little before an ISO time. */
const searchFrom = (iso: string): string =>
  (Date.parse(iso) / 1000 - SEARCH_SKEW_SECONDS).toFixed(6);

export function createStakeholderSends(deps: SendsDeps): StakeholderSends {
  const { state, slack, clock, log } = deps;

  /** The client of one workspace; null when Slack is off or the workspace is not signed in. */
  const clientOf = (teamId: string | null): SlackClient | null => slack?.clientFor(teamId) ?? null;

  const nowIso = (): string => clock.now().toISOString();

  function liveSend(cardId: InboxItemId, db: DbReader = state.db): StakeholderSendDto | null {
    const found = sendForCard(db, cardId);
    return found && ['draft', 'sending', 'sent'].includes(found.state) ? found : null;
  }

  /** The recipients of a send as people, in the order the send names them. */
  function recipientsOf(send: StakeholderSendDto, db: DbReader = state.db): PersonDto[] {
    return send.people.flatMap((p) => (p.recipient && p.personId ? getPerson(db, p.personId) : []));
  }

  function toBuilder(ctx: WriteContext, cardId: InboxItemId): void {
    setInboxRecipients(ctx, cardId, {
      assignees: [BUILDER_HANDLE],
      routedBy: RoutedBy.Builder,
      suggestion: null,
    });
  }

  /** The thread a follow-up joins; one from before the workspace's bot was recorded is never joined. */
  function threadFor(
    card: InboxItemDto,
    people: readonly PersonDto[],
    teamId: string,
    db: DbReader = state.db,
  ) {
    const [taskId] = targetTaskIds(db, card.targets);
    if (taskId === undefined) return null;
    const botSince = readSlackWorkspaces(db).find((w) => w.teamId === teamId)?.botSince ?? null;
    return latestThreadFor(
      db,
      people.map((p) => p.id),
      taskId,
      teamId,
      botSince,
    );
  }

  /** Sends whose post this process is making now: a tick must not look for them or post them again. */
  const inFlight = new Set<string>();

  function builderUnnamed(card: InboxItemDto, db: DbReader = state.db): boolean {
    return draftContext(db, card).builderName === SEED_BUILDER_NAME;
  }

  /**
   * Send on a card whose send failed: the same message is drafted again for the same people, the card goes
   * back to them, and their sessions park. Anything else without a live draft stays a conflict.
   */
  function redraftFailed(card: InboxItemDto): StakeholderSendDto | null {
    const failed = sendForCard(state.db, card.id);
    if (failed?.state !== 'failed' || card.state !== InboxState.Open) return null;
    const outcome = state.write((ctx) => {
      const people = failed.people.flatMap((p) =>
        p.recipient && p.personId ? [getPerson(ctx.tx, p.personId)] : [],
      );
      const teamId = deps.slackFor(card.projectId);
      if (teamId === null) throw new ConflictError(SLACK_OFF_FOR_PROJECT);
      setInboxRecipients(ctx, card.id, {
        assignees: people.map((p) => p.handle),
        routedBy: RoutedBy.Builder,
        suggestion: null,
      });
      const unreachable = people.filter((p) => contactIn(p, teamId) === null);
      if (unreachable.length > 0) {
        // As anyone unreachable: the card is the builder's, with Copy for them.
        setInboxRecipients(ctx, card.id, {
          assignees: [BUILDER_HANDLE],
          routedBy: RoutedBy.Builder,
          suggestion: null,
        });
        updateInboxItem(ctx, card.id, {
          detail: { ...card.detail, [COPY_FOR_KEY]: people.map((p) => p.handle) },
        });
        return { missing: unreachable.map((p) => p.name) };
      }
      // Composed again, not copied: the builder's name or the card may have changed since.
      const fresh = previewDraft(ctx.tx, card, people);
      return {
        draft: insertDraft(ctx, {
          inboxItemId: card.id,
          teamId,
          recipients: people.map((p) => p.id),
          text: fresh.text,
          hits: fresh.hits,
        }),
      };
    });
    if ('missing' in outcome)
      throw new ConflictError(
        `${outcome.missing.join(', ')} has no Slack contact in this project's workspace; copy the message for them`,
      );
    const again = outcome.draft;
    deps.parkFor?.(card.id);
    return again;
  }

  /**
   * Decides what a fresh draft does and reserves it in one write: held for the builder, or `sending`, which
   * counts toward the person's limit at once. Two cards decided together cannot both pass a limit, and a
   * draft is never left unheld and unsent: if the post fails here, `recoverSending` finishes it.
   */
  /**
   * A draft the builder did not edit is composed again at Send, so it carries the builder's name as it is
   * now and the card as it is now, not as they were when it was drafted.
   */
  function recomposed(card: InboxItemDto, stored: StakeholderSendDto): StakeholderSendDto {
    // A text the builder wrote, even if its Send failed before posting, is posted as he wrote it.
    if (sendSummary(state.db, stored.id).byBuilder) return stored;
    const fresh = previewDraft(state.db, card, recipientsOf(stored));
    if (fresh.text === stored.text) return stored;
    state.write((ctx) => {
      updateDraft(ctx, stored.id, { text: fresh.text, hits: fresh.hits });
    });
    return { ...stored, text: fresh.text, hits: fresh.hits };
  }

  async function afterDraft(cardId: InboxItemId): Promise<void> {
    if (slack === null) return;
    const reserved = state.write((ctx) => {
      const card = getInboxItem(ctx.tx, cardId);
      const draft = liveSend(cardId, ctx.tx);
      if (draft?.state !== 'draft' || card.state !== InboxState.Open) return null;
      // A project with Slack off keeps its draft in the Inbox, and the card says why before Send is pressed.
      const teamId = deps.slackFor(card.projectId);
      if (teamId === null) {
        setHeldBy(ctx, draft.id, 'slack_off');
        return null;
      }
      if (draft.teamId !== teamId) {
        // A binding change drafts again in the same write; only a race leaves a draft in another team.
        log.warn({ cardId, draftTeam: draft.teamId, teamId }, 'a draft is in another workspace');
        return null;
      }
      const people = recipientsOf(draft, ctx.tx);
      const thread = threadFor(card, people, teamId, ctx.tx);
      const since = new Date(clock.now().getTime() - DAY_MS).toISOString();
      const held = holdFor({
        hits: draft.hits,
        thread,
        recipients: people.map((p) => {
          const contact = contactIn(p, teamId);
          return {
            sendMode: contact?.sendMode ?? 'review',
            dailyLimit: contact?.dailyLimit ?? null,
            newThreads: contact === null ? 0 : newThreadsSince(ctx.tx, p.id, teamId, since),
          };
        }),
      });
      // A message from a builder who is still called "You" would read "You's build": he reviews it.
      const reason = held ?? (builderUnnamed(card, ctx.tx) ? 'review' : null);
      setHeldBy(ctx, draft.id, reason);
      if (reason !== null) return null;
      markSending(ctx, draft.id, {
        textSha256: sha256(draft.text),
        threadTs: thread?.threadTs ?? null,
        channelId: thread?.channelId ?? null,
        startedAt: nowIso(),
      });
      return draft.id;
    });
    if (reserved !== null) await continueSending(reserved);
  }

  /** Opens the conversation of a reserved send if it has none, then posts it. */
  async function continueSending(sendId: StakeholderSendDto['id']): Promise<void> {
    if (slack === null || inFlight.has(sendId)) return;
    inFlight.add(sendId);
    try {
      const row = sendingSends(state.db).find((x) => x.id === sendId);
      if (!row) return;
      const { inboxItemId, text } = sendSummary(state.db, sendId);
      const card = getInboxItem(state.db, inboxItemId);
      if (card.state !== InboxState.Open) {
        // The card closed before anything was posted: there is nothing to open and nothing to say.
        const reason = closeReasonOf(card, true) ?? 'cancelled';
        state.write((ctx) => {
          closeSend(ctx, sendId, reason);
        });
        return;
      }
      // A send reserved in another team than the stored binding is taken back, never posted.
      if (row.teamId !== deps.boundTo(card.projectId)) {
        fail(sendId, inboxItemId, SendFailure.WorkspaceChanged);
        return;
      }
      // A workspace that is not signed in leaves the send waiting, as a missing token does.
      const client = clientOf(row.teamId);
      if (client === null || row.teamId === null) return;
      let channelId = row.channelId;
      if (channelId === null) {
        const found = sendForCard(state.db, inboxItemId);
        try {
          const opened = await channelFor(
            client,
            found ? recipientsOf(found) : [],
            row.teamId,
            null,
          );
          state.write((ctx) => {
            setSendChannel(ctx, sendId, opened);
          });
          channelId = opened;
        } catch (error) {
          const code = slackCode(error);
          if (TRANSPORT.test(code) || code === 'no_token') {
            log.warn({ sendId, code }, 'a drafted question waits for Slack; it is tried again');
            return;
          }
          fail(sendId, inboxItemId, code);
          return;
        }
      }
      await postMessage(client, sendId, inboxItemId, channelId, row.threadTs, text);
    } finally {
      inFlight.delete(sendId);
    }
  }

  /** Opens the conversation the question goes to; a follow-up uses the thread's own. */
  async function channelFor(
    client: SlackClient,
    people: readonly PersonDto[],
    teamId: string,
    thread: { channelId: string } | null,
  ): Promise<string> {
    if (thread) return thread.channelId;
    const contacts = people.map((p) => ({ person: p, contact: contactIn(p, teamId) }));
    const [only] = contacts;
    if (contacts.length === 1 && only?.contact) {
      const { person, contact } = only;
      // A bot change cleared the channel it had, so a stale one is never used.
      if (contact.dmChannelId !== null) return contact.dmChannelId;
      const channel = await client.openDm(contact.userId);
      state.write((ctx) => {
        setDmChannel(ctx, person.id, teamId, channel);
      });
      return channel;
    }
    return client.openGroup(contacts.flatMap((c) => c.contact?.userId ?? []));
  }

  /** Marks a send failed and gives its card back to the builder. */
  function fail(sendId: StakeholderSendDto['id'], cardId: InboxItemId, code: string): void {
    state.write((ctx) => {
      failSendsToBuilder(ctx, [{ id: sendId, inboxItemId: cardId }], code);
    });
  }

  /**
   * Posts a draft: opens the conversation, starts the send, posts with the send's id in the message
   * metadata, and records the ids. A connection that fails before the post leaves the draft; one that
   * fails during it leaves the send `sending` for `recoverSending`; a refusal fails the send.
   */
  async function post(cardId: InboxItemId, teamId: string, client: SlackClient): Promise<void> {
    const draft = liveSend(cardId);
    if (draft?.state !== 'draft') throw new ConflictError('There is no draft to send');
    const card = getInboxItem(state.db, cardId);
    const people = recipientsOf(draft);
    const thread = threadFor(card, people, teamId);
    let channelId: string;
    try {
      channelId = await channelFor(client, people, teamId, thread);
    } catch (error) {
      const code = slackCode(error);
      if (TRANSPORT.test(code) || code === 'no_token')
        throw new ConflictError(`Slack could not be reached (${code}); the draft is kept`);
      // Refused before it began: starting and failing the send are one write.
      state.write((ctx) => {
        markSending(ctx, draft.id, {
          textSha256: sha256(draft.text),
          threadTs: thread?.threadTs ?? null,
          startedAt: nowIso(),
        });
        failSendsToBuilder(ctx, [{ id: draft.id, inboxItemId: cardId }], code);
      });
      return;
    }
    state.write((ctx) => {
      markSending(ctx, draft.id, {
        textSha256: sha256(draft.text),
        threadTs: thread?.threadTs ?? null,
        channelId,
        startedAt: nowIso(),
      });
    });
    inFlight.add(draft.id);
    try {
      await postMessage(client, draft.id, cardId, channelId, thread?.threadTs ?? null, draft.text);
    } finally {
      inFlight.delete(draft.id);
    }
  }

  async function postMessage(
    client: SlackClient,
    sendId: StakeholderSendDto['id'],
    cardId: InboxItemId,
    channelId: string,
    threadTs: string | null,
    text: string,
  ): Promise<void> {
    try {
      const { ts } = await client.post({
        channel: channelId,
        text,
        blocks: blocksOf(text),
        ...(threadTs === null ? {} : { threadTs }),
        metadata: { eventType: SEND_METADATA, eventPayload: { sendId } },
      });
      await landed(client, sendId, cardId, channelId, threadTs ?? ts, ts);
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      const code = slackCode(error);
      if (TRANSPORT.test(code)) {
        log.warn(
          { sendId, code },
          'a question may or may not have posted; it is checked next tick',
        );
        return;
      }
      fail(sendId, cardId, code);
    }
  }

  /** The post is known: record it, then settle a card the builder closed while it was in flight. */
  async function landed(
    client: SlackClient,
    sendId: StakeholderSendDto['id'],
    cardId: InboxItemId,
    channelId: string,
    threadTs: string,
    messageTs: string,
    at: string = nowIso(),
  ): Promise<void> {
    const permalink = await client.permalink(channelId, messageTs).catch(() => null);
    try {
      state.write((ctx) => {
        markSent(ctx, sendId, { channelId, threadTs, messageTs, permalink, at });
      });
    } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      // The post landed after a change of workspace or bot failed its send: it is never recorded sent and
      // never drafted again, and the thread is told the question was taken back.
      const failed = sendForCard(state.db, cardId);
      if (
        failed?.id !== sendId ||
        (failed.error !== SendFailure.WorkspaceChanged && failed.error !== SendFailure.BotChanged)
      )
        throw error;
      await sayTakenBack(client, cardId, channelId, threadTs);
      return;
    }
    const card = getInboxItem(state.db, cardId);
    const reason = closeReasonOf(card, true);
    if (reason !== null) await closeAndSay(sendId, card, reason);
  }

  /** Says in a thread that its question was taken back; a Slack error is logged, never retried. */
  async function sayTakenBack(
    client: SlackClient,
    cardId: InboxItemId,
    channelId: string,
    threadTs: string,
  ): Promise<void> {
    const card = getInboxItem(state.db, cardId);
    const line = closingLine('taken_back', draftContext(state.db, card).builderName, null);
    try {
      await client.post({ channel: channelId, text: line, blocks: blocksOf(line), threadTs });
    } catch (error) {
      log.warn({ err: error, cardId }, 'a closing line could not be posted');
    }
  }

  /** Why the builder's side closed a send, from the card as it stands; null when it did not. */
  function closeReasonOf(
    card: InboxItemDto,
    takenBackIsBuilderCard: boolean,
  ): ClosingReason | null {
    if (card.answer?.via === 'slack') return null;
    switch (card.state) {
      case InboxState.Answered:
      case InboxState.Delivering:
      case InboxState.Resolved:
        if (card.answer === null) return 'cancelled';
        return isParkChoice(card.answer.choice) ? 'taken_back' : 'builder';
      case InboxState.Cancelled:
      case InboxState.Expired:
        return 'cancelled';
      case InboxState.Open:
        return takenBackIsBuilderCard && card.assignees.every((h) => h === BUILDER_HANDLE)
          ? 'taken_back'
          : null;
      default: {
        const unreachable: never = card.state;
        return unreachable;
      }
    }
  }

  function letterOf(card: InboxItemDto): string | null {
    const choice = card.answer?.choice;
    if (choice === undefined) return null;
    const index = card.options
      .filter((o) => !isParkChoice(o.label))
      .findIndex((o) => o.label === choice);
    return index >= 0 ? (OPTION_LETTERS[index] ?? null) : null;
  }

  /** Closes a posted send and says why in every thread it used; a Slack error is logged, never retried. */
  async function closeAndSay(
    sendId: StakeholderSendDto['id'],
    card: InboxItemDto,
    reason: ClosingReason,
  ): Promise<void> {
    const closed = state.write((ctx) => {
      const live = sendForCard(ctx.tx, card.id);
      if (live?.id !== sendId || live.state !== 'sent') return null;
      // A send in another team than the stored binding is taken back, and its thread is told so.
      if (
        live.teamId !== deps.boundTo(card.projectId) &&
        getInboxItem(ctx.tx, card.id).state === InboxState.Open
      ) {
        failSendsToBuilder(
          ctx,
          [{ id: sendId, inboxItemId: card.id }],
          SendFailure.WorkspaceChanged,
        );
        return { teamId: live.teamId, reason: 'taken_back' as const };
      }
      closeSend(ctx, sendId, reason);
      return { teamId: live.teamId, reason };
    });
    const slackClient = clientOf(closed?.teamId ?? null);
    if (closed === null || slackClient === null) return;
    const builder = draftContext(state.db, card).builderName;
    const line = closingLine(closed.reason, builder, letterOf(card));
    const said = new Set<string>();
    for (;;) {
      // The threads are read again after each post, so a conversation that moved is not missed.
      const next = sendThreadsOf(state.db, sendId).find(
        (t) => !said.has(`${t.channelId}/${t.threadTs}`),
      );
      if (!next) return;
      said.add(`${next.channelId}/${next.threadTs}`);
      try {
        await slackClient.post({
          channel: next.channelId,
          text: line,
          blocks: blocksOf(line),
          threadTs: next.threadTs,
        });
      } catch (error) {
        log.warn({ err: error, sendId }, 'a closing line could not be posted');
      }
    }
  }

  return {
    afterDraft,

    async send(cardId, input) {
      if (slack === null) throw new ConflictError('Slack is not connected');
      const card = getInboxItem(state.db, cardId);
      const teamId = deps.slackFor(card.projectId);
      if (teamId === null) throw new ConflictError(SLACK_OFF_FOR_PROJECT);
      const client = slack.clientFor(teamId);
      if (client === null || (await deps.hasToken?.(teamId)) === false)
        throw new ConflictError('Slack is not connected');
      const stored = liveSend(cardId) ?? redraftFailed(card);
      if (card.state !== InboxState.Open || stored?.state !== 'draft')
        throw new ConflictError('There is no draft to send');
      if (stored.teamId !== teamId) {
        // A binding change drafts again in the same write; only a race leaves a draft in another team.
        log.warn({ cardId, draftTeam: stored.teamId, teamId }, 'a draft is in another workspace');
        throw new ConflictError('This draft is for another Slack workspace');
      }
      const draft = input.text === undefined ? recomposed(card, stored) : stored;
      const hits: OutboundHit[] =
        input.text === undefined
          ? mergeHits(draft.hits, scanOutbound(draft.text))
          : scanOutbound(input.text);
      const holds = hits.filter((h) => h.severity === 'hold').map((h) => h.pattern);
      if (holds.length > 0)
        throw new InvalidError(
          `The message is held for ${[...new Set(holds)].join(', ')}; edit it first`,
        );
      if (draft.heldBy === 'limit' && input.overrideLimit !== true)
        throw new ConflictError("This person is at today's limit; use Send Anyway");
      if (input.text !== undefined) {
        const text = neutralizeAngles(input.text);
        state.write((ctx) => {
          updateDraft(ctx, draft.id, { text, hits, byBuilder: true });
        });
      }
      await post(cardId, teamId, client);
      return sendForCard(state.db, cardId) ?? draft;
    },

    askSomeone(cardId, input) {
      const card = getInboxItem(state.db, cardId);
      if (card.kind !== InboxKind.Question || card.state !== InboxState.Open)
        throw new ConflictError('Only an open question can be asked of someone');
      const existing = sendForCard(state.db, cardId);
      if (existing?.state === 'sending' || existing?.state === 'sent')
        throw new ConflictError('Take it back first');
      const people = input.personIds.map((id) => getPerson(state.db, id));
      const after = state.write((ctx) => {
        if (input.always) {
          const always = input.always;
          const rules = listRoutingRules(ctx.tx, card.projectId).map((r) => ({
            category: r.category,
            topic: r.topic,
            goalId: r.goalId,
            taskId: r.taskId,
            area: r.area,
            personId: r.personId,
          }));
          for (const category of always.categories)
            for (const person of people) {
              const same = rules.some(
                (r) =>
                  r.category === category &&
                  r.personId === person.id &&
                  r.goalId === always.goalId &&
                  r.taskId === always.taskId &&
                  r.area === null,
              );
              if (!same)
                rules.push({
                  category,
                  topic: null,
                  goalId: always.goalId,
                  taskId: always.taskId,
                  area: null,
                  personId: person.id,
                });
            }
          setRoutingRules(ctx, card.projectId, { rules });
        }
        const routed = setInboxRecipients(ctx, cardId, {
          assignees: people.map((p) => p.handle),
          routedBy: RoutedBy.Builder,
          suggestion: null,
        });
        const old = sendForCard(ctx.tx, cardId);
        if (old?.state === 'draft') dropDraft(ctx, old.id);
        return draftFor(ctx, routed, {
          ...draftContext(ctx.tx, routed),
          afterDraft: (id) => {
            afterDraft(id).catch((error: unknown) => {
              log.warn({ err: error, cardId: id }, 'a drafted question could not be sent');
            });
          },
          log,
        });
      });
      deps.parkFor?.(cardId);
      after?.();
    },

    async takeBack(cardId) {
      const found = liveSend(cardId);
      if (!found) throw new ConflictError('There is nothing to take back');
      state.write((ctx) => {
        toBuilder(ctx, cardId);
        if (found.state === 'draft') closeSend(ctx, found.id, 'taken_back');
      });
      // A post still in flight is closed, and the line said, once it lands (`landed`).
      if (found.state === 'sent')
        await closeAndSay(found.id, getInboxItem(state.db, cardId), 'taken_back');
    },

    closingTextFor(cardId) {
      const card = getInboxItem(state.db, cardId);
      const reason = closeReasonOf(card, true);
      return reason === null
        ? null
        : closingLine(reason, draftContext(state.db, card).builderName, letterOf(card));
    },

    keepWaiting(cardId) {
      const found = liveSend(cardId);
      if (found?.state !== 'sent' || found.returnedAt === null)
        throw new ConflictError('This question has not come back to you');
      state.write((ctx) => {
        keepWaiting(ctx, found.id, nowIso());
      });
    },

    async recoverSending(teamId) {
      // A workspace that is not signed in leaves its sends waiting, as a missing token does.
      const client = clientOf(teamId);
      if (client === null) return;
      for (const pending of sendingSends(state.db, teamId)) {
        if (inFlight.has(pending.id)) continue;
        const send = sendSummary(state.db, pending.id);
        const owner = getInboxItem(state.db, send.inboxItemId);
        const moved = pending.teamId !== deps.boundTo(owner.projectId);
        if (pending.channelId === null) {
          // Nothing was posted yet; continueSending takes a moved send back.
          await continueSending(pending.id);
          continue;
        }
        inFlight.add(pending.id);
        try {
          const messages =
            pending.threadTs === null
              ? await client.history(pending.channelId, searchFrom(pending.startedAt))
              : await client.replies(
                  pending.channelId,
                  pending.threadTs,
                  searchFrom(pending.startedAt),
                );
          const found = messages.find((m) => namesSend(m, pending.id));
          if (moved) {
            // Only a race leaves this: the send is taken back, and a post that did land is told so.
            fail(pending.id, send.inboxItemId, SendFailure.WorkspaceChanged);
            if (found)
              await sayTakenBack(
                client,
                send.inboxItemId,
                pending.channelId,
                pending.threadTs ?? found.ts,
              );
          } else if (found) {
            // The send dates from the message itself, not from when a restart found it.
            await landed(
              client,
              pending.id,
              send.inboxItemId,
              pending.channelId,
              pending.threadTs ?? found.ts,
              found.ts,
              new Date(tsMillis(found.ts)).toISOString(),
            );
          } else if (getInboxItem(state.db, send.inboxItemId).state !== InboxState.Open) {
            // The card closed while the post was in flight and nothing landed: there is nothing to post.
            const card = getInboxItem(state.db, send.inboxItemId);
            const reason = closeReasonOf(card, true) ?? 'cancelled';
            state.write((ctx) => {
              closeSend(ctx, pending.id, reason);
            });
          } else {
            await postMessage(
              client,
              pending.id,
              send.inboxItemId,
              pending.channelId,
              pending.threadTs,
              send.text,
            );
          }
        } catch (error) {
          log.warn({ err: error, sendId: pending.id }, 'a send in flight could not be checked yet');
        } finally {
          inFlight.delete(pending.id);
        }
      }
    },

    async onCardChanged(card) {
      const found = sendForCard(state.db, card.id);
      if (!found) return;
      if (found.state === 'draft') {
        // A card settled before its message went leaves nothing to say to anyone.
        const reason = closeReasonOf(card, false);
        if (reason === null) return;
        state.write((ctx) => {
          const live = sendForCard(ctx.tx, card.id);
          if (live?.id === found.id && live.state === 'draft')
            closeSend(ctx, found.id, reason === 'builder' ? 'builder' : 'cancelled');
        });
        return;
      }
      if (found.state !== 'sent') return;
      const reason = closeReasonOf(card, false);
      if (reason !== null) await closeAndSay(found.id, card, reason);
    },
  };
}

function namesSend(message: SlackMessage, sendId: string): boolean {
  return (
    message.metadata?.eventType === SEND_METADATA &&
    message.metadata.eventPayload['sendId'] === sendId
  );
}

function mergeHits(a: readonly OutboundHit[], b: readonly OutboundHit[]): OutboundHit[] {
  const merged = [...a];
  for (const hit of b) if (!merged.some((h) => h.pattern === hit.pattern)) merged.push(hit);
  return merged;
}
