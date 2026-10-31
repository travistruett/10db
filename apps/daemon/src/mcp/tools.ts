import {
  ClaimKind,
  currentStep,
  EventType,
  FOLLOW_UPS_HEADING,
  InvalidError,
  MAX_STEP_SUMMARY,
  McpToolName,
  McpToolOutputs,
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
  findToolOp,
  getBatch,
  getProject,
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
  patchWorkstream,
  releaseClaim,
  searchDecisions,
  type ClaimRow,
  type Json,
} from '@10db/db';
import type { z } from 'zod';
import { buildContextPack } from '../briefing';
import { checkoutOf, MIGRATIONS_HAZARD, type MigrationsBase } from '../delivery';
import type { StateStore } from '../events';
import type { Git } from '../git';
import { judgeToolUse, type ProtectedPath } from '../guard';
import type { InboxService, WaitObserver } from '../inbox';
import type { Logger } from '../log';
import { CLAIM_POLL_MS, CLAIM_WAIT_SLICE_MS, ClaimWaits, type ClaimResult } from './claim-wait';

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
}

type In<K extends McpToolName> = z.output<(typeof McpToolInputs)[K]>;
type Out<K extends McpToolName> = z.output<(typeof McpToolOutputs)[K]>;
export type ToolHandlers = { [K in McpToolName]: (input: In<K>) => Promise<Out<K>> };

export const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  get_context:
    'Your context pack: the task, acceptance criteria, your claims, the latest handoff, any answer waiting for you, and relevant decisions.',
  find_knowledge:
    'Search recorded decisions in scope for this project. Returns an explicit empty result when nothing matches.',
  ask_human:
    'Ask the builder a structured question and wait for the answer. Use for decisions outside routine engineering.',
  record_decision:
    'Record a routine engineering decision you made within your authority, with its rationale.',
  propose:
    'Propose a new task, a task change, or a principle. Proposals go to the builder; nothing changes until accepted.',
  report_deviation: 'Report a departure from the plan or a principle, with your signed reason.',
  request_claim:
    'Ask for an additional area or hazard claim before editing files in it. When another task holds it, this waits until it frees and returns granted: true, so do not carry on without it; the builder sees a card naming the holder and that you are waiting. A long wait answers granted: false with waiting: true before the call times out: call again with the same opId to keep waiting. granted: false with waiting: false means waiting would deadlock (the holder is waiting for a claim you hold), or, for the migrations hazard, that your branch could not take its base first: follow the instruction it returns.',
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
  const recordClaim = (opId: string, settled: ClaimResult): Out<'request_claim'> =>
    deps.state.write((ctx) => {
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
              instruction: null,
            },
        ctx,
      );
    });

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
      inboxId: taken.inboxId,
      instruction: taken.instruction,
    };
  }

  return {
    get_context: () => Promise.resolve(buildContextPack(db, getWorkstream(db, workstreamId))),

    find_knowledge: ({ query, limit }) => {
      const results = searchDecisions(db, context().project.id, query, limit);
      return Promise.resolve({ results, empty: results.length === 0 });
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
      return Promise.resolve(
        deps.state.write((ctx) => {
          const sourceId = insertSource(ctx, 'agent', { sessionId, workstreamId });
          const proposalId = insertProposal(ctx, {
            projectId: project.id,
            kind: input.kind,
            title: input.title,
            body: input.body,
            sourceId,
          });
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
          return record('propose', input.opId, { proposalId }, ctx);
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
      const done = prior(input.opId, McpToolName.CompleteStep);
      if (done !== undefined) return Promise.resolve(McpToolOutputs.complete_step.parse(done));
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
          return record(
            'complete_step',
            input.opId,
            { instruction: 'Recorded. End your turn now.', followUps: filed },
            ctx,
          );
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
