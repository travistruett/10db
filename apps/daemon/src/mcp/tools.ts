import {
  ClaimKind,
  currentStep,
  EventType,
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
  insertToolOp,
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
import { fileProposalByItself, proposalFiling } from '../inbox';
import type { InboxService, WaitObserver } from '../inbox';
import { principleHit, proposePrinciple } from '../knowledge';
import type { Logger } from '../log';
import {
  CLAIM_POLL_MS,
  CLAIM_WAIT_SLICE_MS,
  ClaimWaits,
  deadlockWaitInstruction,
  yieldRefusal,
  type ClaimResult,
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
  /** Every session's claim waits; the daemon shares them with the scheduler. */
  readonly claimWaits?: ClaimWaits;
  /** How often a task waiting for a claim looks again; tests shorten it. */
  readonly claimPollMs?: number;
  /** How long one request_claim call waits before answering "still waiting"; tests shorten it. */
  readonly claimWaitSliceMs?: number;
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

export const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  get_context:
    'Your context pack: the task, acceptance criteria, your claims, the latest handoff, any answer waiting for you, and relevant decisions.',
  find_knowledge:
    'Search the current decisions and confirmed principles that apply to this project, each labelled with its scope and area. Set kind to decision or principle to search one shelf; limit applies to each shelf. Returns an explicit empty result when nothing matches.',
  ask_human:
    'Ask the builder a structured question and wait for the answer. Use for decisions outside routine engineering. 10db adds a "Park the task" choice to every card; if the builder picks it, your run stops (you get no answer) and the task is parked, so never ask the same question again to get around it.',
  record_decision:
    'Record a routine engineering decision you made within your authority, with its rationale.',
  propose:
<<<<<<< 754c4abfad643cb825faa5154fa981b97e81efe2
    'Propose a new task, a task change, or a principle. Proposals go to the builder; nothing changes until accepted. Exception: a small new-task proposal with no risk tag is filed to the Icebox by 10db itself, naming your task, with no Inbox card. Set riskTags (security, auth, migration, dependency) when the work carries one, and joinsRunningBatch when it must join a batch that is running; either raises the card.',
||||||| 122e914
    'Propose a new task, a task change, or a principle. Proposals go to the builder; nothing changes until accepted.',
=======
    'Propose a new task, a task change, or a principle (with the principle field: statement, kind, topicKey, scope). Proposals go to the builder; nothing changes until accepted, and you never confirm a principle yourself.',
>>>>>>> 83a19a13be65c163a1206bcd7444120346aa67b7
  report_deviation: 'Report a departure from the plan or a principle, with your signed reason.',
  file_follow_up:
    'File work that does not fit this task as a separate task in the Icebox column, naming this task in its description. Use it when a design or docs change would grow past about 300 lines: stop at a coherent point and file each remaining section. One call per task; the builder decides when it starts. A step can file at most 10 (MAX_FOLLOW_UPS); after that the call is refused.',
  request_claim:
    'Ask for an additional area or hazard claim before editing files in it. When another task holds it, this waits until it frees and returns granted: true, so do not carry on without it; the builder sees a card naming the holder and that you are waiting. A long wait answers granted: false with waiting: true before the call times out: call again with the same opId to keep waiting. granted: false with waiting: false means you did not get it: the builder made your task give up claims to end a deadlock (you no longer hold them), or, for the migrations hazard, your branch could not take its base first. Follow the instruction it returns.',
  install_dependencies:
    "Install the dependency change you made in your copy's package.json files. Edit the manifests first, with each new or changed dependency pinned to an exact version (no ^, ~ or range), then call this: 10db resolves them, writes pnpm-lock.yaml and installs, outside your sandbox, so every workspace package still resolves its dependencies. Never run pnpm add or pnpm install yourself: your sandbox cannot, and it can leave the copy's node_modules broken. Commit the changed package.json files and pnpm-lock.yaml with the commit tool afterwards. If it answers installed: false, follow its instruction and call again with a new opId.",
  commit:
    'Commit the named paths (and only those) under the repository lock. Returns the commit SHA. Retry with the same opId if unsure it completed.',
  record_evidence: 'Attach verification output: a command you ran, its exit code and a summary.',
  write_handoff:
    'Write the six-part handoff when 10db asks you to. 10db adds the git facts. End your turn after calling it.',
  complete_step:
    'Finish a plan, plan-review, review or QA step: your plan or findings as the summary and, for a review, a verdict. Implement steps never call this; they end by ending the turn.',
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

  /** A claim call's settled result, recorded under its opId. */
  const recordClaim = (opId: string, settled: ClaimResult): Out<'request_claim'> => {
    const out = deps.state.write((ctx) => {
      // Two calls with the same opId can share one wait; the first records it, the second reads it.
      const recorded = findToolOp(ctx.tx, workstreamId, opId);
      if (recorded) return McpToolOutputs.request_claim.parse(recorded.result);
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
            const { proposalId, principle } = proposePrinciple(ctx, {
              projectId: project.id,
              title: input.title,
              body: input.body,
              draft,
              sourceId,
              speaker: `agent:${sessionId}`,
            });
            return record('propose', input.opId, { proposalId, principleId: principle.id }, ctx);
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
          });
          if (filing.file) {
            // A small proposal with no risk tag: the card would guard nothing the Icebox does not.
            const task = fileProposalByItself(ctx, proposalId);
            return record('propose', input.opId, { proposalId, taskId: task.id }, ctx);
          }
          insertInboxItem(ctx, {
            projectId: project.id,
            kind: 'proposal',
            title: input.title,
            body: input.body,
            options: [
              { label: 'accept', description: 'Accept the proposal' },
              { label: 'reject', description: 'Reject it' },
            ],
            recommendation: null,
            category: QuestionCategory.Product,
            urgency: Urgency.Low,
            detail: { proposalId },
            foldKey: null,
            targets: [],
          });
<<<<<<< 754c4abfad643cb825faa5154fa981b97e81efe2
          return record('propose', input.opId, { proposalId, taskId: null }, ctx);
||||||| 122e914
          return record('propose', input.opId, { proposalId }, ctx);
=======
          return record('propose', input.opId, { proposalId, principleId: null }, ctx);
>>>>>>> 83a19a13be65c163a1206bcd7444120346aa67b7
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
          if (countStepToolOps(ctx.tx, ws, McpToolName.FileFollowUp) >= MAX_FOLLOW_UPS)
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
      const { project } = context();
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
        signal: deps.sessionSignal(sessionId) ?? new AbortController().signal,
        pollMs: deps.claimPollMs ?? CLAIM_POLL_MS,
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
          const { heldBy, inboxId } = wait.state;
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
        return recordClaim(input.opId, settled);
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
      const { project, workstream } = context();
      const checkout = checkoutOf(db, workstream);
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
        return record('commit', input.opId, result, ctx);
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
          const filed = input.followUps.map((followUp) => {
            const task = insertFollowUpTask(ctx, row.taskId, followUp);
            return { taskId: task.id, title: task.title };
          });
          // The builder finds the follow-ups from the step's result, so they are written into it.
          const summary =
            filed.length === 0
              ? input.summary
              : [
                  input.summary,
                  '',
                  FOLLOW_UPS_HEADING,
                  ...filed.map((f) => `- ${f.taskId} ${f.title}`),
                ].join('\n');
          // Throwing here rolls back the tasks filed above.
          if (summary.length > MAX_STEP_SUMMARY)
            throw new InvalidError(
              `Your notes and the list of follow-up tasks 10db adds are over ${String(MAX_STEP_SUMMARY)} characters; send shorter notes.`,
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
              followUps: filed.map((f) => f.taskId),
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
              'Handoff recorded. End your turn now; a fresh session will continue from it.',
          },
          ctx,
        );
      });
    },
  };
}
