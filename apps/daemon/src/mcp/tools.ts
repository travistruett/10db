import {
  AreaRole,
  ClaimKind,
  currentStep,
  EventType,
  filedFollowUpLines,
  FOLLOW_UPS_HEADING,
  InvalidError,
  KnowledgeKindFilter,
  MAX_FOLLOW_UPS,
  MAX_STEP_SUMMARY,
  McpToolName,
  McpToolOutputs,
  PrincipleDraft,
  ProposalKind,
  QuestionCategory,
  REVIEW_ROLES,
  StepRole,
  ToolAccess,
  Urgency,
  type McpToolInputs,
  type SessionId,
  type TaskId,
  type TaskMessageId,
} from '@10db/contracts';
import {
  activeClaims,
  countStepToolOps,
  findToolOp,
  FollowUpOrigin,
  getBatch,
  getProject,
  getSmallProposalLimit,
  getTask,
  getWorkstream,
  getWorkstreamRow,
  insertDecision,
  insertDeviation,
  insertEvidence,
  insertHandoff,
  insertFollowUpTask,
  insertInboxItem,
  insertProposal,
  insertSource,
  insertSystemNotice,
  insertToolOp,
  listEvidence,
  listToolOps,
  listStepToolOpResults,
  openPassTurn,
  passHoldingTask,
  passPageAreas,
  replaceToolOp,
  patchWorkstream,
  releaseClaim,
  searchDecisions,
  searchPrinciples,
  type ClaimRow,
  type Json,
} from '@10db/db';
import type { z } from 'zod';
import { buildContextPack } from '../briefing';
import {
  checkoutOf,
  MIGRATIONS_HAZARD,
  type DependencyChanges,
  type MigrationsBase,
} from '../delivery';
import type { StateStore } from '../events';
import type { Git } from '../git';
import { judgeToolUse, type ProtectedPath } from '../guard';
import {
  carriesRiskTags,
  fileProposalByItself,
  proposalCardBody,
  proposalFiling,
  raisedAsCardLine,
} from '../inbox';
import type { InboxService, WaitObserver } from '../inbox';
import { principleHit, proposePrinciple } from '../knowledge';
import type { Logger } from '../log';
import {
  askMoveToCopy,
  askShared,
  grantSharedHold,
  keepCommitToolPaths,
  moveToCopyInstruction,
  passHazardAsk,
  slowPageLine,
} from '../pass';
import { afterMarkersResolved, commitResultAsStored, fixingFailedGate, revertOfRun } from '../team';
import {
  CLAIM_POLL_MS,
  CLAIM_WAIT_SLICE_MS,
  ClaimWaits,
  deadlockWaitInstruction,
  yieldRefusal,
  type ClaimResult,
  type SharedGrant,
} from './claim-wait';
import type { ShapeToolsFor } from './shape-tools';

export interface McpDeps {
  readonly protectedPaths: readonly ProtectedPath[];
  readonly state: StateStore;
  readonly inbox: InboxService;
  readonly git: Git;
  readonly log: Logger;
  waitObserverFor(sessionId: SessionId): WaitObserver | undefined;
  sessionSignal(sessionId: SessionId): AbortSignal | undefined;
  /** Tells the runner a tool's answer asked the session to hand off. */
  askedToHandOff(sessionId: SessionId): void;
  /** Every session's claim waits; the daemon shares them with the scheduler. */
  readonly claimWaits?: ClaimWaits;
  /** How often a task waiting for a claim looks again; tests shorten it. */
  readonly claimPollMs?: number;
  /** How long one request_claim call waits before answering "still waiting"; tests shorten it. */
  readonly claimWaitSliceMs?: number;
  /** Hands a builder message to its page's session, as the thread does; absent, it waits for the next. */
  readonly deliverMessage?: (taskId: TaskId, messageId: TaskMessageId) => Promise<void>;
  /** Brings a task's base into its branch before it gets the migrations hazard; absent, it isn't. */
  readonly migrationsBase?: MigrationsBase;
  /** Installs a lane's dependency change in its copy; absent, `install_dependencies` is refused. */
  readonly dependencyChanges?: DependencyChanges;
  /** The tools of a Shape conversation's session; absent, such a session is refused. */
  readonly shapeTools?: ShapeToolsFor;
}

type In<K extends McpToolName> = z.output<(typeof McpToolInputs)[K]>;
type Out<K extends McpToolName> = z.output<(typeof McpToolOutputs)[K]>;
export type ToolHandlers = { [K in McpToolName]: (input: In<K>) => Promise<Out<K>> };

/**
 * How many tasks the workstream's current step has filed with no person involved: its file_follow_up
 * calls, and its propose calls that 10db filed to the Icebox itself (a card or a principle has no
 * taskId). The two share MAX_FOLLOW_UPS; a replayed opId is one record, so it counts once.
 * complete_step's followUps are deliberately not counted: they are a review's findings, its end
 * product, a separate allowance (decisions/2026-11-04-a-reviews-complete-step-follow-ups-are-outside-the-step-cap.md),
 * bounded at MAX_FOLLOW_UPS across all the step's complete_step calls by the list in its result
 * (decisions/2026-11-04-complete-step-follow-ups-are-bounded-per-step.md), and filed once under a
 * reused opId (decisions/2026-11-04-a-reused-complete-step-opid-files-no-follow-up-twice.md).
 */
function stepFilings(
  db: Parameters<typeof countStepToolOps>[0],
  ws: Parameters<typeof countStepToolOps>[1],
): number {
  const proposed = listStepToolOpResults(db, ws, McpToolName.Propose).filter(
    (result) =>
      typeof result === 'object' &&
      result !== null &&
      !Array.isArray(result) &&
      typeof result['taskId'] === 'string',
  ).length;
  return proposed + countStepToolOps(db, ws, McpToolName.FileFollowUp);
}

export const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  get_context:
    'Your context pack: the task, acceptance criteria, your claims, the latest handoff, any answer waiting for you, and relevant decisions.',
  find_knowledge:
    'Search the current decisions and confirmed principles that apply to this project, each labelled with its scope and area. Set kind to decision or principle to search one shelf; limit applies to each shelf. Returns an explicit empty result when nothing matches.',
  ask_human:
    'Ask the builder a structured question and wait for the answer. Use for decisions outside routine engineering. 10db adds a "Park the task" choice to your card, except when your task is a page of a Workbench pass; if the builder picks it, your run stops (you get no answer) and the task is parked, so never ask the same question again to get around it.',
  record_decision:
    'Record a routine engineering decision you made within your authority, with its rationale.',
  propose:
    'Propose a new task, a task change, or a principle (with the principle field: statement, kind, topicKey, scope). Proposals go to the builder; nothing changes until accepted, and you never confirm a principle yourself. Exception: a small new-task proposal with no risk tag is filed to the Icebox by 10db itself, naming your task, with no Inbox card. Set riskTags (security, auth, migration, dependency) when the work carries one, and joinsRunningBatch when it must join a batch that is running; either raises the card. A step can have at most 10 tasks filed without a person, between this and file_follow_up; past that, a proposal raises the card. The followUps of complete_step (review roles) are a separate allowance: they do not count toward the 10 and the 10 does not block them.',
  report_deviation: 'Report a departure from the plan or a principle, with your signed reason.',
  file_follow_up:
    'File work that does not fit this task as a separate task in the Icebox column, naming this task in its description. Use it when a design or docs change would grow past about 300 lines: stop at a coherent point and file each remaining section. One call per task; the builder decides when it starts. A step can file at most 10 (MAX_FOLLOW_UPS), counting small proposals 10db files by itself; after that the call is refused. The followUps of complete_step are not counted and are not refused by it.',
  request_claim:
    'Ask for an additional area or hazard claim before editing files in it. When another task holds it, this waits until it frees and returns granted: true, so do not carry on without it; the builder sees a card naming the holder and that you are waiting. A long wait answers granted: false with waiting: true before the call times out: call again with the same opId to keep waiting. granted: false with waiting: false means you did not get it: the builder made your task give up claims to end a deadlock (you no longer hold them), or, for the migrations hazard, your branch could not take its base first. Follow the instruction it returns.',
  install_dependencies:
    "Install the dependency change you made in your copy's package.json files. Edit the manifests first, with each new or changed dependency pinned to an exact version (no ^, ~ or range), then call this: 10db resolves them, writes pnpm-lock.yaml and installs, outside your sandbox, so every workspace package still resolves its dependencies. Never run pnpm add or pnpm install yourself: your sandbox cannot, and it can leave the copy's node_modules broken. Commit the changed package.json files and pnpm-lock.yaml with the commit tool afterwards. If it answers installed: false, follow its instruction and call again with a new opId.",
  commit:
    'Commit the named paths (and only those) under the repository lock. Returns the commit SHA. Retry with the same opId if unsure it completed.',
  record_evidence: 'Attach verification output: a command you ran, its exit code and a summary.',
  write_handoff:
    'Write the six-part handoff when 10db asks you to hand off, or when you must stop with work left: name that work under progress.notDone. 10db adds the git facts. End your turn after calling it. Never call it to finish a step: ending your turn finishes the step, and a handoff that names nothing left ends it too.',
  complete_step:
    'Finish a plan, plan-review, review or QA step: your plan or findings as the summary and, for a review, a verdict. A review role may also send followUps; a step files at most 10 in all through complete_step, however many times you call it, and a call that would pass 10 is refused. They are not counted toward the per-step cap of 10 that propose and file_follow_up share. Implement steps never call this; they end by ending the turn.',
};

export function createToolHandlers(
  deps: McpDeps,
  sessionId: SessionId,
  workstreamId: Parameters<typeof getWorkstream>[1],
  claimWaits: ClaimWaits = new ClaimWaits(),
): ToolHandlers {
  const db = deps.state.db;
  const context = () => {
    const workstream = getWorkstream(db, workstreamId);
    return {
      workstream,
      project: getProject(db, workstream.projectId),
      task: getTask(db, workstream.taskId),
    };
  };

  /** Refuses an area name the calling project doesn't have, naming the ones it has. */
  const requireArea = (area: string): void => {
    const names = context().project.areas.map((a) => a.name);
    if (!names.includes(area))
      throw new InvalidError(`No area named ${area} in this project. Areas: ${names.join(', ')}`);
  };

  /** Returns the recorded result for a repeated opId; throws if the opId belonged to another tool. */
  function prior(opId: string, tool: McpToolName): Json | undefined {
    const op = findToolOp(db, workstreamId, opId);
    if (op && op.tool !== tool)
      throw new InvalidError(`opId ${opId} was already used for ${op.tool}; use a new opId`);
    return op?.result;
  }

  const record = <K extends McpToolName>(
    tool: K,
    opId: string,
    result: Out<K>,
    ctx: Parameters<typeof insertToolOp>[0],
  ): Out<K> => {
    insertToolOp(ctx, { workstreamId, sessionId, opId, tool, result });
    return result;
  };

  /**
   * How a pass lane gets a shared area (Workbench spec §7.2): one turn at a time, with a hold that
   * records what the area held at the grant. Undefined for any other claim.
   */
  const sharedGrantOf = (
    kind: ClaimKind,
    name: string,
    reason: string,
    signal: AbortSignal,
  ): SharedGrant | undefined => {
    if (kind !== ClaimKind.Area) return undefined;
    const { project, task } = context();
    if (!passHoldingTask(db, task)) return undefined;
    if (project.areas.find((a) => a.name === name)?.role !== AreaRole.Shared) return undefined;
    // The turn the call is made in: the wait ends with it, though the next turn opens.
    const turnId = openPassTurn(db, task.id)?.id;
    return {
      ask: () => {
        const asked = askShared(
          {
            ...deps,
            logger: deps.log,
            ...(deps.deliverMessage ? { deliver: deps.deliverMessage } : {}),
          },
          { workstreamId, sessionId, area: name, reason, signal },
        );
        if (!asked) return null;
        return {
          inboxId: asked.inboxId,
          answer: asked.answer.then((given): ClaimResult | null =>
            given.allowed
              ? null
              : {
                  granted: false,
                  heldBy: null,
                  inboxId: asked.inboxId,
                  instruction: given.instruction,
                  yielded: false,
                  parked: false,
                },
          ),
        };
      },
      grant: () => grantSharedHold({ ...deps, logger: deps.log }, { workstreamId, area: name }),
      turnOpen: () => turnId !== undefined && openPassTurn(db, task.id)?.id === turnId,
    };
  };

  /**
   * A claim call's settled result, recorded under its opId, with `line` added to the task's thread
   * when it is the call that records it.
   */
  const recordClaim = (
    opId: string,
    settled: ClaimResult,
    line: string | null = null,
  ): Out<'request_claim'> => {
    const out = deps.state.write((ctx) => {
      // Two calls with the same opId can share one wait; the first records it, the second reads it.
      const recorded = findToolOp(ctx.tx, workstreamId, opId);
      if (recorded) return McpToolOutputs.request_claim.parse(recorded.result);
      if (line !== null) insertSystemNotice(ctx, getWorkstream(ctx.tx, workstreamId).taskId, line);
      return record(
        'request_claim',
        opId,
        settled.granted
          ? { granted: true, claimId: settled.claim.id }
          : {
              granted: false,
              heldBy: settled.heldBy,
              inboxId: settled.inboxId,
              waiting: false,
              instruction: settled.instruction,
            },
        ctx,
      );
    });
    // The agent now knows which claims the builder made its task give up.
    if (!settled.granted && settled.yielded) claimWaits.yieldDelivered(workstreamId);
    return out;
  };

  /**
   * Brings the base into the task's branch before the migrations hazard just granted counts, so a
   * migration the task generates is numbered after the base's latest. Null once it may have the hazard;
   * otherwise what the call answers, unrecorded, so a retry with the same opId asks again. A branch that
   * can't take its base gives the hazard back. The base still coming in when `slice` ends answers
   * "still waiting" with the hazard kept, and the retry joins the same merge.
   */
  async function migrationsFirst(
    claimId: ClaimRow['id'],
    slice: Promise<'slice'>,
  ): Promise<Out<'request_claim'> | null> {
    if (!deps.migrationsBase) return null;
    const signal = deps.sessionSignal(sessionId) ?? new AbortController().signal;
    const taken = await Promise.race([deps.migrationsBase.take(workstreamId, signal), slice]);
    if (taken === 'slice')
      return {
        granted: false,
        waiting: true,
        heldBy: null,
        inboxId: null,
        instruction:
          "10db is still bringing this branch's base from origin into it, so that a migration you generate is numbered after the base's latest. Don't generate or write a migration yet: call request_claim again with the same opId, and edit nothing in it until a call returns granted: true.",
      };
    if (taken.kind === 'ready') return null;
    deps.state.write((ctx) => releaseClaim(ctx, claimId));
    if (taken.kind === 'aborted')
      throw new InvalidError(
        'This session stopped before 10db brought the base into its branch, so it did not get the migrations hazard. End your turn.',
      );
    return {
      granted: false,
      waiting: false,
      heldBy: null,
      inboxId: null,
      instruction: taken.instruction,
    };
  }

  return {
    get_context: () => Promise.resolve(buildContextPack(db, getWorkstream(db, workstreamId))),

    find_knowledge: ({ query, limit, kind }) => {
      const projectId = context().project.id;
      // The limit applies to each shelf. Only current records are searched: a proposed, superseded,
      // retired or withdrawn one never reaches an agent.
      const results =
        kind === KnowledgeKindFilter.Principle ? [] : searchDecisions(db, projectId, query, limit);
      const principles =
        kind === KnowledgeKindFilter.Decision
          ? []
          : searchPrinciples(db, projectId, query, limit).map(principleHit);
      return Promise.resolve({
        results,
        principles,
        empty: results.length === 0 && principles.length === 0,
      });
    },

    ask_human: async (input) => {
      const done = prior(input.opId, McpToolName.AskHuman);
      if (done !== undefined) return McpToolOutputs.ask_human.parse(done);
      const { project } = context();
      const signal = deps.sessionSignal(sessionId) ?? new AbortController().signal;
      const { item, answer } = deps.inbox.ask({
        projectId: project.id,
        workstreamId,
        sessionId,
        kind: 'question',
        title: input.question,
        body: [
          input.consequences,
          input.affectedScope ? `Affects: ${input.affectedScope}` : undefined,
        ]
          .filter(Boolean)
          .join('\n'),
        options: input.options,
        recommendation: input.recommendation ?? null,
        category: input.category,
        urgency: input.urgency,
        detail: null,
        signal,
      });
      const observer = deps.waitObserverFor(sessionId);
      observer?.onWaitStart(item);
      const result = await answer;
      observer?.onWaitEnd(item);
      return deps.state.write((ctx) =>
        record(
          'ask_human',
          input.opId,
          { inboxId: item.id, answer: result.choice, note: result.note ?? null },
          ctx,
        ),
      );
    },

    record_decision: (input) => {
      const done = prior(input.opId, McpToolName.RecordDecision);
      if (done !== undefined) return Promise.resolve(McpToolOutputs.record_decision.parse(done));
      if (input.scope === 'area' && !input.area)
        throw new InvalidError(
          'A decision with scope "area" needs the area field naming the area.',
        );
      if (input.scope !== 'area' && input.area)
        throw new InvalidError(
          'The area field is only for decisions with scope "area"; omit it for project scope.',
        );
      if (input.area !== undefined) requireArea(input.area);
      const { project } = context();
      return Promise.resolve(
        deps.state.write((ctx) => {
          const sourceId = insertSource(ctx, 'agent', { sessionId, workstreamId });
          const decisionId = insertDecision(ctx, {
            projectId: project.id,
            question: input.question,
            choice: input.choice,
            rationale: input.rationale,
            decidedBy: `agent:${sessionId}`,
            scope: input.scope,
            area: input.area ?? null,
            sourceId,
          });
          return record('record_decision', input.opId, { decisionId }, ctx);
        }),
      );
    },

    propose: (input) => {
      const done = prior(input.opId, McpToolName.Propose);
      if (done !== undefined) return Promise.resolve(McpToolOutputs.propose.parse(done));
      const { project } = context();
      if (input.principle && input.kind !== ProposalKind.Principle)
        throw new InvalidError('The principle field is only for proposals of kind "principle".');
      if (input.principle?.area !== undefined) requireArea(input.principle.area);
      let draft: PrincipleDraft | null = null;
      if (input.kind === ProposalKind.Principle) {
        // With no draft, the body is the statement when it is short enough to be one.
        const parsed = PrincipleDraft.safeParse(input.principle ?? { statement: input.body });
        if (!parsed.success)
          throw new InvalidError(
            'A principle proposal needs the principle field, or a body of at most 500 characters to use as its statement.',
          );
        draft = parsed.data;
      }
      return Promise.resolve(
        deps.state.write((ctx) => {
          const sourceId = insertSource(ctx, 'agent', { sessionId, workstreamId });
          if (draft) {
            // Every principle gets a card, so its tags are the one thing the card must add.
            const carries = carriesRiskTags(input.riskTags);
            const { proposalId, principle } = proposePrinciple(ctx, {
              projectId: project.id,
              title: input.title,
              body: input.body,
              draft,
              sourceId,
              speaker: `agent:${sessionId}`,
              cardNote: carries === null ? null : raisedAsCardLine(carries),
            });
            return record(
              'propose',
              input.opId,
              { proposalId, taskId: null, principleId: principle.id },
              ctx,
            );
          }
          const proposalId = insertProposal(ctx, {
            projectId: project.id,
            kind: input.kind,
            title: input.title,
            body: input.body,
            sourceId,
          });
          const filing = proposalFiling({
            kind: input.kind,
            title: input.title,
            body: input.body,
            riskTags: input.riskTags,
            joinsRunningBatch: input.joinsRunningBatch,
            limit: getSmallProposalLimit(ctx.tx, project.id),
            stepCapReached:
              stepFilings(ctx.tx, getWorkstreamRow(ctx.tx, workstreamId)) >= MAX_FOLLOW_UPS,
          });
          if (filing.file) {
            // A small proposal with no risk tag: the card would guard nothing the Icebox does not.
            const task = fileProposalByItself(ctx, proposalId);
            return record(
              'propose',
              input.opId,
              { proposalId, taskId: task.id, principleId: null },
              ctx,
            );
          }
          insertInboxItem(ctx, {
            projectId: project.id,
            kind: 'proposal',
            title: input.title,
            body: proposalCardBody(input.body, filing.reason),
            options: [
              { label: 'accept', description: 'Accept the proposal' },
              { label: 'reject', description: 'Reject it' },
            ],
            recommendation: null,
            category: QuestionCategory.Product,
            urgency: Urgency.Low,
            // The declared risk tags ride on the card, so accepting it files a task that carries them.
            detail: { proposalId, riskTags: [...new Set(input.riskTags ?? [])] },
            foldKey: null,
            targets: [],
          });
          return record(
            'propose',
            input.opId,
            { proposalId, taskId: null, principleId: null },
            ctx,
          );
        }),
      );
    },

    file_follow_up: (input) => {
      const done = prior(input.opId, McpToolName.FileFollowUp);
      if (done !== undefined) return Promise.resolve(McpToolOutputs.file_follow_up.parse(done));
      return Promise.resolve(
        deps.state.write((ctx) => {
          // A step can span sessions (handoff, re-launch, recovery), so count the whole step's filings.
          const ws = getWorkstreamRow(ctx.tx, workstreamId);
          if (stepFilings(ctx.tx, ws) >= MAX_FOLLOW_UPS)
            throw new InvalidError(
              `A step can file at most ${String(MAX_FOLLOW_UPS)} follow-up tasks and you have filed that many. Stop filing; put what is left in your summary or handoff, and end your turn.`,
            );
          const task = insertFollowUpTask(
            ctx,
            ws.taskId,
            {
              title: input.title,
              description: input.description,
              acceptanceCriteria: input.acceptanceCriteria,
            },
            FollowUpOrigin.Left,
          );
          return record('file_follow_up', input.opId, { taskId: task.id, title: task.title }, ctx);
        }),
      );
    },

    report_deviation: (input) => {
      const done = prior(input.opId, McpToolName.ReportDeviation);
      if (done !== undefined) return Promise.resolve(McpToolOutputs.report_deviation.parse(done));
      const { project } = context();
      return Promise.resolve(
        deps.state.write((ctx) => {
          const sourceId = insertSource(ctx, 'agent', { sessionId, workstreamId });
          const deviationId = insertDeviation(ctx, {
            projectId: project.id,
            workstreamId,
            cause: input.cause,
            severity: input.severity,
            signedReason: `${input.reason} (agent:${sessionId})`,
            sourceId,
          });
          return record('report_deviation', input.opId, { deviationId }, ctx);
        }),
      );
    },

    request_claim: async (input) => {
      const done = prior(input.opId, McpToolName.RequestClaim);
      if (done !== undefined) return McpToolOutputs.request_claim.parse(done);
      const { project, task } = context();
      // A name that is a project hazard is a hazard claim whatever kind the agent sent; claims are keyed on (kind, name).
      const hazardNames = project.hazards.map((h) => h.name);
      const areaNames = project.areas.map((a) => a.name);
      const kind = hazardNames.includes(input.name) ? ClaimKind.Hazard : ClaimKind.Area;
      if (kind === ClaimKind.Area && !areaNames.includes(input.name)) {
        throw new InvalidError(
          `No area or hazard named ${input.name}. Areas: ${areaNames.join(', ')}. Hazards: ${hazardNames.join(', ')}`,
        );
      }
      // Claims the builder made this task give up are told before anything else is granted.
      const given = claimWaits.pendingYield(workstreamId);
      if (given) return recordClaim(input.opId, yieldRefusal(given, { kind, name: input.name }));
      // A pass page asking for migrations or deps leaves Your folder for a copy where the project
      // allows copies: the builder is asked to move it, and the claim is refused meanwhile. A page
      // never holds one: its launch claims only its pass's areas.
      const passAsk =
        kind === ClaimKind.Hazard
          ? passHazardAsk(db, project, task, input.name)
          : ({ kind: 'none' } as const);
      if (passAsk.kind === 'move')
        return deps.state.write((ctx) => {
          const asked = askMoveToCopy(ctx, {
            pass: passAsk.pass,
            taskId: task.id,
            workstreamId,
            hazard: input.name,
          });
          return record(
            'request_claim',
            input.opId,
            {
              granted: false,
              heldBy: null,
              inboxId: asked.inboxId,
              waiting: false,
              instruction: moveToCopyInstruction(input.name, asked.notNow),
            },
            ctx,
          );
        });
      const signal = deps.sessionSignal(sessionId) ?? new AbortController().signal;
      const shared = sharedGrantOf(kind, input.name, input.reason, signal);
      // A claim another task holds is waited for, not given up on. Every call for the claim joins the
      // one wait; a call answers "still waiting" before the session's tool timeout, and is not recorded,
      // so a retry with the same opId joins the wait again.
      const wait = claimWaits.join({
        state: deps.state,
        inbox: deps.inbox,
        projectId: project.id,
        workstreamId,
        kind,
        name: input.name,
        reason: input.reason,
        signal,
        pollMs: deps.claimPollMs ?? CLAIM_POLL_MS,
        ...(shared ? { shared } : {}),
      });
      let timer: NodeJS.Timeout | undefined;
      // The slice listens to no signal: a session that stops ends the wait itself, with its error. It
      // covers the whole call, the base brought in for the migrations hazard included.
      const slice = new Promise<'slice'>((resolve) => {
        timer = setTimeout(() => {
          resolve('slice');
        }, deps.claimWaitSliceMs ?? CLAIM_WAIT_SLICE_MS);
      });
      try {
        let result = await Promise.race([wait.done, slice]);
        if (result === 'slice') {
          const { heldBy, inboxId, askId } = wait.state;
          if (askId !== null) {
            // The answer may come while no call waits for it: it is kept under the opId then.
            // A parked holder is a fact about now, never kept: a later call asks again.
            wait.done
              .then((settled) => {
                if (!settled.granted && settled.parked) return;
                recordClaim(input.opId, settled);
              })
              .catch((error: unknown) => {
                deps.log.warn(
                  {
                    workstreamId,
                    opId: input.opId,
                    err: error instanceof Error ? error.message : String(error),
                  },
                  'a shared claim answer was not kept under its opId',
                );
              });
            return {
              granted: false,
              waiting: true,
              heldBy: null,
              inboxId: askId,
              instruction: `Waiting for the builder's answer about shared ${kind} ${input.name}; call request_claim again with the same opId, and edit nothing in it until a call returns granted: true.`,
            };
          }
          if (heldBy !== null && inboxId !== null)
            return {
              granted: false,
              waiting: true,
              heldBy,
              inboxId,
              instruction: deadlockWaitInstruction(db, kind, input.name, heldBy),
            };
          if (heldBy !== null)
            return {
              granted: false,
              waiting: true,
              heldBy,
              // The wait shows on the task's card, not in the Inbox: the builder is asked nothing.
              inboxId: null,
              instruction: `Still waiting for ${kind} ${input.name}: task "${getTask(db, getWorkstream(db, heldBy).taskId).title}" holds it. Call request_claim again with the same opId to keep waiting, and edit nothing in it until a call returns granted: true.`,
            };
          // The wait ended as the slice did; its result is a moment away.
          result = await wait.done;
        }
        const settled = result;
        if (settled.granted && kind === ClaimKind.Hazard && input.name === MIGRATIONS_HAZARD) {
          const refused = await migrationsFirst(settled.claim.id, slice);
          if (refused) return refused;
        }
        // A parked holder is a fact about now, not the call's answer: a retry with the same opId asks again.
        if (!settled.granted && settled.parked) {
          // Its instruction asks for a handoff when the session can't finish without the claim.
          deps.askedToHandOff(sessionId);
          return {
            granted: false,
            waiting: false,
            heldBy: settled.heldBy,
            inboxId: settled.inboxId,
            instruction: settled.instruction,
          };
        }
        return recordClaim(
          input.opId,
          settled,
          settled.granted && passAsk.kind === 'slow' ? slowPageLine(input.name) : null,
        );
      } finally {
        clearTimeout(timer);
      }
    },

    install_dependencies: async (input) => {
      const done = prior(input.opId, McpToolName.InstallDependencies);
      if (done !== undefined) return McpToolOutputs.install_dependencies.parse(done);
      if (currentStep(getWorkstreamRow(db, workstreamId)).tools === ToolAccess.ReadOnly)
        throw new InvalidError(
          'This step is read-only; only an implement step changes dependencies.',
        );
      const row = getWorkstreamRow(db, workstreamId);
      const changes = deps.dependencyChanges;
      if (changes === undefined || row.batchId === null)
        throw new InvalidError(
          'This task has no copy of its own to install into. Ask the builder with ask_human to add the dependency.',
        );
      const outcome = await changes.install(
        row.batchId,
        deps.sessionSignal(sessionId) ?? new AbortController().signal,
      );
      if (outcome.kind === 'aborted')
        throw new InvalidError('The install was stopped because your session is ending.');
      const result: Out<'install_dependencies'> =
        outcome.kind === 'installed'
          ? {
              installed: true,
              changed: [...outcome.changed],
              logPath: outcome.logPath,
              instruction: `Installed. Commit the changed package.json files and pnpm-lock.yaml with the commit tool (changed in your copy: ${outcome.changed.join(', ') || 'nothing'}). Do not run pnpm yourself.`,
            }
          : outcome.kind === 'refused'
            ? { installed: false, changed: [], logPath: null, instruction: outcome.reason }
            : {
                installed: false,
                changed: [],
                logPath: outcome.logPath,
                instruction: `${outcome.summary} Fix what it names (a version that does not exist, a registry 10db may not reach) and call install_dependencies again with a new opId; if the project's registry host is blocked, a card already asks the builder to allow it. Do not run pnpm yourself.`,
              };
      return deps.state.write((ctx) => record('install_dependencies', input.opId, result, ctx));
    },

    commit: async (input) => {
      const done = prior(input.opId, McpToolName.Commit);
      if (done !== undefined) return McpToolOutputs.commit.parse(done);
      if (currentStep(getWorkstreamRow(db, workstreamId)).tools === ToolAccess.ReadOnly)
        throw new InvalidError('This step is read-only; only an implement step commits.');
      const { project, workstream, task } = context();
      const checkout = checkoutOf(db, workstream);
      const pass = passHoldingTask(db, task);
      if (pass) {
        // A pass lane's work is kept at its task's ref, never committed on the pass's branch.
        const claimed = activeClaims(db, workstreamId).map((c) => ({ kind: c.kind, name: c.name }));
        const inPass = { pages: passPageAreas(db, pass.id) };
        const kept = await keepCommitToolPaths(deps, {
          workstreamId,
          paths: input.paths,
          opId: input.opId,
          judge: (path) => {
            const verdict = judgeToolUse({
              toolName: 'Write',
              toolInput: { file_path: path },
              repoPath: checkout,
              areas: project.areas,
              hazards: project.hazards,
              claims: claimed,
              readOnly: false,
              inPass,
              protectedPaths: deps.protectedPaths,
            });
            return verdict.decision === 'deny' ? verdict.reason : null;
          },
        });
        return deps.state.write((ctx) => record('commit', input.opId, { ...kept }, ctx));
      }
      // A batch names its branch; other work commits on the branch pinned at its first session.
      const row = getWorkstreamRow(db, workstreamId);
      const branch = row.batchId ? getBatch(db, row.batchId).branch : row.branch;
      if (branch === null)
        throw new InvalidError(
          'This work has no branch to commit on: the checkout was on a detached HEAD when its first session started. Ask the builder with ask_human to check out a branch and restart the task.',
        );
      const claims = activeClaims(db, workstreamId).map((c) => ({ kind: c.kind, name: c.name }));
      for (const path of input.paths) {
        const verdict = judgeToolUse({
          toolName: 'Write',
          toolInput: { file_path: path },
          repoPath: checkout,
          areas: project.areas,
          hazards: project.hazards,
          claims,
          readOnly: false,
          protectedPaths: deps.protectedPaths,
        });
        if (verdict.decision === 'deny') throw new InvalidError(verdict.reason);
      }
      const result = await deps.git.commit({
        repo: checkout,
        paths: input.paths,
        message: input.message,
        opId: input.opId,
        branch,
      });
      // The record says when this commit resolved conflict markers of a base merge: it is on the branch
      // but brings none of a reverted task's work back. The session's answer is unchanged.
      // It also says when the tool made no new commit and handed the session one the run's revert
      // covers (an opId reused from the reverted commits): that brought no work back either.
      // And when the session was fixing a failed gate, read from the run's record so a question, a usage
      // limit or a handoff does not lose it: the commit adapts or repairs, and brings no work back.
      const evidence = listEvidence(db, workstreamId);
      const told = result.alreadyCommitted ? revertOfRun({ notice: row.notice, evidence }) : null;
      const stored = await commitResultAsStored(deps.git, checkout, result, told?.revert ?? null, {
        throughGate: fixingFailedGate(evidence),
        afterResolution: afterMarkersResolved(
          listToolOps(db, workstreamId, McpToolName.Commit),
          evidence,
        ),
      });
      return deps.state.write((ctx) => {
        ctx.emit({
          type: EventType.CommitRecorded,
          entityType: 'workstream',
          entityId: workstreamId,
          data: {
            sha: result.sha,
            paths: [...input.paths],
            alreadyCommitted: result.alreadyCommitted,
          },
        });
        insertToolOp(ctx, {
          workstreamId,
          sessionId,
          opId: input.opId,
          tool: McpToolName.Commit,
          result: stored,
        });
        return result;
      });
    },

    record_evidence: (input) => {
      const done = prior(input.opId, McpToolName.RecordEvidence);
      if (done !== undefined) return Promise.resolve(McpToolOutputs.record_evidence.parse(done));
      return Promise.resolve(
        deps.state.write((ctx) => {
          const evidence = insertEvidence(ctx, {
            workstreamId,
            kind: 'agent',
            command: input.command,
            exitCode: input.exitCode,
            summary: input.summary,
            logPath: null,
            commitShas: [],
          });
          return record('record_evidence', input.opId, { evidenceId: evidence.id }, ctx);
        }),
      );
    },

    complete_step: (input) => {
      // A reply is replayed only to the session it was given to: that is a retry of a lost answer.
      // An opId an earlier session of the task used is a new verdict, which must be recorded; replaying
      // the old "Recorded" for it left a rerun review with no result, and the task failed for it.
      const earlier = findToolOp(db, workstreamId, input.opId);
      if (earlier && earlier.tool !== McpToolName.CompleteStep)
        throw new InvalidError(
          `opId ${input.opId} was already used for ${earlier.tool}; use a new opId`,
        );
      if (earlier?.sessionId === sessionId)
        return Promise.resolve(McpToolOutputs.complete_step.parse(earlier.result));
      return Promise.resolve(
        deps.state.write((ctx) => {
          const row = getWorkstreamRow(ctx.tx, workstreamId);
          const step = currentStep(row);
          if (step.role === StepRole.Implement)
            throw new InvalidError(
              'An implement step ends by ending your turn; 10db runs the gate.',
            );
          if (REVIEW_ROLES.includes(step.role) && input.verdict === null)
            throw new InvalidError('This review step needs a verdict: approve or reject.');
          // Only a review role gives a verdict; a plan step's is dropped so a later reader cannot mistake it for one.
          const verdict = REVIEW_ROLES.includes(step.role) ? input.verdict : null;
          if (input.followUps.length > 0 && !REVIEW_ROLES.includes(step.role))
            throw new InvalidError(
              'Only a review, plan review or QA step files follow-up tasks; leave followUps out of a plan.',
            );
          // The step's result lists every follow-up it has filed. A later call replaces the notes but
          // carries that list forward, and the list is what bounds the step: complete_step may file at
          // most MAX_FOLLOW_UPS in all, however many times it is called or by which session.
          const kept = filedFollowUpLines(step.result?.summary ?? '');
          // An earlier session that used this opId has already filed its follow-ups. This call is a
          // retry or a rerun of it, so a follow-up with the title of one of those is that one: the reply
          // names it again but it is not filed twice. Each earlier follow-up matches at most one input.
          const alreadyFiled = earlier
            ? McpToolOutputs.complete_step.parse(earlier.result).followUps
            : [];
          const unmatched = [...alreadyFiled];
          const toFile = input.followUps.filter((followUp) => {
            const at = unmatched.findIndex((f) => f.title === followUp.title);
            if (at === -1) return true;
            unmatched.splice(at, 1);
            return false;
          });
          // Only a call that files something is bounded. The list is read back from the notes, so notes that
          // hold their own "Follow-up tasks filed:" lines can make it look longer than what was filed; a
          // call that files nothing must still be able to replace such a result.
          if (toFile.length > 0 && kept.length + toFile.length > MAX_FOLLOW_UPS)
            throw new InvalidError(
              `A step can file at most ${String(MAX_FOLLOW_UPS)} follow-up tasks through complete_step and this step's result already lists ${String(kept.length)}. Send at most ${String(Math.max(0, MAX_FOLLOW_UPS - kept.length))} followUps, and put the rest in your notes.`,
            );
          const newlyFiled = toFile.map((followUp) => {
            const task = insertFollowUpTask(ctx, row.taskId, followUp);
            return { taskId: task.id, title: task.title };
          });
          // The stored reply keeps every filing under this opId, so a later reuse still matches them.
          const filed = [...alreadyFiled, ...newlyFiled];
          // The builder finds the follow-ups from the step's result, so they are written into it. Only
          // this run's go in, which is what the check above bounds: a filing of a round before the step
          // was entered again stays in the result that round left in `earlier`, and carrying it in
          // could take the list past the bound and refuse a later call that files nothing.
          const listed = [...kept, ...newlyFiled.map((f) => `- ${f.taskId} ${f.title}`)];
          const summary =
            listed.length === 0
              ? input.summary
              : [input.summary, '', FOLLOW_UPS_HEADING, ...listed].join('\n');
          // Throwing here rolls back the tasks filed above.
          if (summary.length > MAX_STEP_SUMMARY)
            throw new InvalidError(
              `Your notes and the list of follow-up tasks this step has filed, which 10db adds to them, are over ${String(MAX_STEP_SUMMARY)} characters; send shorter notes.`,
            );
          const result = { summary, verdict, sessionId, at: ctx.now };
          patchWorkstream(ctx, workstreamId, null, {
            steps: row.steps.map((s, i) => (i === row.stepIndex ? { ...s, result } : s)),
          });
          ctx.emit({
            type: EventType.StepChanged,
            entityType: 'workstream',
            entityId: workstreamId,
            data: {
              stepIndex: row.stepIndex,
              role: step.role,
              verdict,
              followUps: newlyFiled.map((f) => f.taskId),
            },
          });
          const reply = { instruction: 'Recorded. End your turn now.', followUps: filed };
          if (!earlier) return record('complete_step', input.opId, reply, ctx);
          replaceToolOp(ctx, {
            workstreamId,
            sessionId,
            opId: input.opId,
            tool: McpToolName.CompleteStep,
            result: reply,
          });
          return reply;
        }),
      );
    },

    write_handoff: async ({ opId, ...content }) => {
      const done = prior(opId, McpToolName.WriteHandoff);
      if (done !== undefined) return McpToolOutputs.write_handoff.parse(done);
      const row = getWorkstreamRow(db, workstreamId);
      const checkout = checkoutOf(db, row);
      const head = await deps.git.head(checkout);
      const base = row.baseHead ?? head;
      const [changed, commits] = await Promise.all([
        deps.git.changedFilesSince(checkout, base),
        deps.git.commitsSince(checkout, base),
      ]);
      return deps.state.write((ctx) => {
        const handoff = insertHandoff(ctx, {
          workstreamId,
          sessionId,
          content,
          gitHead: head,
          gitChangedFiles: changed,
          gitCommits: commits,
        });
        return record(
          'write_handoff',
          opId,
          {
            handoffId: handoff.id,
            instruction:
              'Handoff recorded. End your turn now. A fresh session continues from it when 10db asked for it or it names work left; otherwise it counts as finishing your step, so a step that records a result with complete_step must still do so.',
          },
          ctx,
        );
      });
    },
  };
}
