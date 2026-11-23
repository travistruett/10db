import {
  InvalidError,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeOrigin,
  ShapeToolInputs,
  type ChatId,
  type ConversationId,
  type PlanDraft,
  type ProjectId,
  type SeeScreenInput,
  type SessionId,
  type ShapeId,
} from '@10db/contracts';
import {
  ensurePlanOfChat,
  findRecords,
  insertShapeMessage,
  planOfChat,
  similarTasks,
} from '@10db/db';
import type { StateStore } from '../events';
import type { ShapeToolHandlers } from '../mcp';
import type { ScreenService } from '../screens';
import { attach } from './attach';
import { createFigmaTools } from './figma';
import { reconcileDraft } from './rounds';
import { stampReview, type ShapeReviewTurn } from './review-turn';
import { reportFinding, resolveFinding, writeSpec } from './review';
import { buildSizes } from './sizing';
import { ceremonies, type ViewWorld } from './view';

// Shape spec §5.5. The Plan tools a chat's session calls through the `10db` MCP server. Each handler looks the
// chat's plan up when it is called, so a plan made mid-session is found at once. `propose_plan` is the one that
// can make it; `note_heard` and the two searches work without one, and the tools that need rows are refused.

export interface ShapeToolDeps {
  readonly state: StateStore;
  /** What the ceremony rule reads about the project: its one-way paths (§7). */
  world?(shapeId: ShapeId): ViewWorld;
  /** Draws the app's screens for `see_screen` (§5.5); the tool is not offered without it. */
  readonly screens?: {
    /** The service's `see` with the limits of the conversation's account already given. */
    see(shapeId: ShapeId, input: SeeScreenInput): ReturnType<ScreenService['see']>;
  };
  /** The `fetch` that posts a mock-up to Figma and reads its assets; the real one by default. */
  readonly figmaFetch?: typeof fetch;
  /** Takes the planning rules the calling session is owed, once (`ChatLive.planRules`). */
  readonly owedRules?: (conversationId: ConversationId, sessionId: SessionId) => string | null;
  /** Whether the calling session runs no subagents (`ChatLive.inSession`). */
  readonly noSubagents?: (conversationId: ConversationId, sessionId: SessionId) => boolean;
  /** The reviews the calling session has been sent (`ChatLive.review`): its own findings are stamped from it. */
  readonly reviewOf?: (
    conversationId: ConversationId,
    sessionId: SessionId,
  ) => readonly ShapeReviewTurn[];
}

/** The chat a handler set serves: the session's tools are held to it. */
export interface ShapeToolChat {
  readonly chatId: ChatId;
  readonly conversationId: ConversationId;
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
}

/** The words of a Plan tool called in a session with no plan. */
export const NO_PLAN_YET = 'This session has no Plan yet: propose_plan starts one.';

/** A refused round that made the plan it was for: thrown inside the write so the plan rolls back with it. */
class RefusedFirstRoundError extends Error {
  override readonly name = 'RefusedFirstRoundError';
  readonly errors: readonly string[];
  constructor(errors: readonly string[]) {
    super('the first round was refused');
    this.errors = errors;
  }
}

const refusal = (errors: readonly string[]): InvalidError =>
  new InvalidError(
    `${plural(errors.length, errors.length === 1 ? 'error' : 'errors')}; nothing was changed. Fix them all and call propose_plan again:\n${errors.map((e) => `- ${e}`).join('\n')}`,
  );

const plural = (n: number, noun: string): string => `${String(n)} ${noun}`;
const round = (n: number): number => Math.round(n * 100) / 100;

const SIMILAR_LIMIT = 10;
const RECORDS_LIMIT = 10;

/** The draft's size in the words the transcript's dimmed line uses: "1 goal, 3 tasks". */
function describeDraft(draft: PlanDraft): string {
  const parts = [
    draft.goals.length > 0
      ? plural(draft.goals.length, draft.goals.length === 1 ? 'goal' : 'goals')
      : '',
    draft.looseTasks.length > 0
      ? plural(draft.looseTasks.length, draft.looseTasks.length === 1 ? 'task' : 'tasks')
      : '',
    draft.records.length > 0
      ? plural(draft.records.length, draft.records.length === 1 ? 'record' : 'records')
      : '',
    draft.additions.length + draft.changes.length + draft.removals.length > 0
      ? plural(
          draft.additions.length + draft.changes.length + draft.removals.length,
          'change to what was converted',
        )
      : '',
  ].filter((p) => p !== '');
  return parts.length > 0 ? parts.join(', ') : 'nothing';
}

export function createShapeToolHandlers(
  deps: ShapeToolDeps,
  chat: ShapeToolChat,
): ShapeToolHandlers {
  const { screens } = deps;
  const figma = createFigmaTools(
    { state: deps.state, fetch: deps.figmaFetch ?? fetch },
    chat.projectId,
  );
  const planNow = (): ShapeId | null => planOfChat(deps.state.db, chat.chatId);
  const line = (shapeId: ShapeId, body: string): void => {
    deps.state.write((ctx) => {
      insertShapeMessage(ctx, shapeId, {
        author: ShapeMessageAuthor.Claude,
        kind: ShapeMessageKind.Tool,
        body,
      });
    });
  };
  // A dimmed line goes in the transcript only when there is a plan to hold it.
  const lineIfPlan = (body: string): void => {
    const shapeId = planNow();
    if (shapeId !== null) line(shapeId, body);
  };
  // A tool that needs the plan's rows: refused with no plan, else run on the plan found now.
  const withPlan = (run: (shapeId: ShapeId) => unknown): Promise<unknown> => {
    const shapeId = planNow();
    if (shapeId === null) return Promise.reject(new InvalidError(NO_PLAN_YET));
    return Promise.resolve().then(() => run(shapeId));
  };
  return {
    note_heard: (input) => {
      const shapeId = planNow();
      if (shapeId === null) return Promise.resolve({ heard: 0 });
      line(shapeId, `note_heard · ${input.items.join(' · ')}`);
      return Promise.resolve({ heard: input.items.length });
    },
    similar_tasks: (input) => {
      const tasks = similarTasks(deps.state.db, chat.projectId, input.query, SIMILAR_LIMIT).map(
        (t) => ({
          taskId: t.taskId,
          title: t.title,
          laneHours: round(t.laneMinutes / 60),
          ...(t.sessionsOnly ? { sessionsOnly: true } : {}),
          wallHours: round(t.wallMinutes / 60),
          tokens: t.tokens,
        }),
      );
      lineIfPlan(`similar_tasks · ${plural(tasks.length, tasks.length === 1 ? 'task' : 'tasks')}`);
      return Promise.resolve({ tasks });
    },
    find_records: (input) => {
      const records = findRecords(deps.state.db, chat.projectId, input.query, RECORDS_LIMIT);
      // Each hit is cited as a dimmed line with its date, so a contradiction is on record (§5.5).
      lineIfPlan(
        records.length === 0
          ? 'find_records · nothing recorded'
          : `find_records · ${records
              .map((r) =>
                r.kind === 'decision'
                  ? `Decided ${r.createdAt.slice(0, 10)}: ${r.question} ${r.choice}`
                  : `Principle ${r.createdAt.slice(0, 10)} (${r.principleKind}, ${r.topicKey}): ${r.statement}`,
              )
              .join(' · ')}`,
      );
      return Promise.resolve({ records });
    },
    ...(screens === undefined
      ? {}
      : {
          see_screen: (input: SeeScreenInput) => withPlan((shapeId) => screens.see(shapeId, input)),
        }),
    attach: (input) =>
      withPlan((shapeId) => deps.state.write((ctx) => attach(ctx, shapeId, input))),
    send_mockup_to_figma: (input) => withPlan((shapeId) => figma.send(shapeId, input)),
    file_figma_version: (input) => withPlan((shapeId) => figma.fileVersion(shapeId, input)),
    write_spec: (input) =>
      withPlan((shapeId) => deps.state.write((ctx) => writeSpec(ctx, shapeId, input))),
    report_finding: (input) => {
      // A session in a review turn reports as that review; the model's own `reviewer` is only the lens a
      // plan review reads through. A reviewer subagent's call arrives stamped by the hook, outside any turn.
      const reviews = deps.reviewOf?.(chat.conversationId, chat.sessionId) ?? [];
      // A session with no subagents reports only as its live review. One with none left (Stop raced the
      // hook) is refused, never written unstamped. A reviewer subagent's call arrives stamped.
      if (deps.noSubagents?.(chat.conversationId, chat.sessionId) === true && reviews.length === 0)
        return Promise.reject(
          new InvalidError(
            'Only a reviewer reports a finding; this session has no review turn running.',
          ),
        );
      const stamped =
        reviews.length === 0
          ? input
          : ShapeToolInputs.report_finding.parse(stampReview(reviews, input));
      return withPlan((shapeId) => deps.state.write((ctx) => reportFinding(ctx, shapeId, stamped)));
    },
    resolve_finding: (input) =>
      withPlan((shapeId) => deps.state.write((ctx) => resolveFinding(ctx, shapeId, input))),
    propose_plan: (input) => {
      // The plan (when this call makes it), the reconcile and its transcript line are one write: the line
      // never disagrees with the rows, and a first round that is refused leaves no plan behind.
      let outcome;
      try {
        outcome = deps.state.write((ctx) => {
          const { shapeId, made } = ensurePlanOfChat(ctx, chat.chatId, ShapeOrigin.App);
          const result = reconcileDraft(ctx, shapeId, input.draft);
          if (!result.ok && made) throw new RefusedFirstRoundError(result.errors);
          insertShapeMessage(ctx, shapeId, {
            author: ShapeMessageAuthor.Claude,
            kind: ShapeMessageKind.Tool,
            body: result.ok
              ? `propose_plan · ${describeDraft(input.draft)} · passed`
              : `propose_plan · refused · ${plural(result.errors.length, result.errors.length === 1 ? 'error' : 'errors')}`,
          });
          return { result, shapeId };
        });
      } catch (error) {
        if (error instanceof RefusedFirstRoundError) return Promise.reject(refusal(error.errors));
        throw error;
      }
      const { result, shapeId } = outcome;
      if (!result.ok) return Promise.reject(refusal(result.errors));
      // The rule, not Claude's guess, says which efforts need a spec before Convert (§7).
      const needSpec = ceremonies(
        deps.state.db,
        shapeId,
        buildSizes(deps.state.db, shapeId),
        deps.world?.(shapeId) ?? { oneWayNames: new Set() },
      )
        .filter((c) => c.ceremony === 'spec' && !c.specWritten)
        .map((c) => c.key);
      // A passing round hands a session whose plan began mid-session the planning rules, once.
      const rules = deps.owedRules?.(chat.conversationId, chat.sessionId) ?? null;
      return Promise.resolve({
        round: result.round,
        created: result.created,
        updated: result.updated,
        superseded: result.superseded,
        kept: result.kept,
        converted: result.converted,
        ...(rules === null ? {} : { rules }),
        ...(needSpec.length === 0
          ? {}
          : {
              needSpec,
              next: 'These efforts need a spec: write it with write_spec, then launch the scope and engineering reviewers.',
            }),
      });
    },
  };
}
