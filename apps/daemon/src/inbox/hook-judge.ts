import {
  JudgeKind,
  PrecedentState,
  SkipKind,
  SkipSource,
  type ProjectId,
  type TaskId,
  type TrustPolicy,
  type TrustPrecedentDto,
  type TrustPrecedentId,
  type WorkstreamId,
} from '@10db/contracts';
import { countPrecedentConflict, countPrecedentUse, setPrecedent } from '@10db/db';
import { z } from 'zod';
import type { Clock } from '../clock';
import type { StateStore } from '../events';
import type { CommittedReader } from '../folders';
import type { GuardVerdict } from '../guard';
import type { Judge } from '../judge';
import type { Logger } from '../log';
import type { JudgedCallRequest } from '../sessions';
import {
  callKey,
  callRuns,
  callSummary,
  crossesLimit,
  type CallRuns,
  type LimitVerdict,
  isGrantedCall,
  keyPackageFile,
  packageScriptLine,
  PRECEDENT_CONFLICTS_MAX,
  precedentFor,
  programKey,
  projectGrantedCalls,
  runsHash,
  skipMessage,
  type FastPathContext,
  type LimitAt,
  type ShownPrecedent,
  type SkipRecorder,
} from '../trust';

/** How long after 10db's judge timed out or failed its calls go straight to the rules, so a down OpenRouter costs one wait. */
export const FLOOR_BACKOFF_MS = 60_000;

/** The most tool use ids whose limits are kept for their cards; the oldest is dropped first. */
const NOTED_IDS_MAX = 256;
/** The most calls a session remembers the judges' verdict on; the oldest is forgotten first. */
export const SETTLED_CALLS_MAX = 512;

/**
 * The limits 10db's judge stopped calls at, by tool use id, for the card the broker raises next. A Codex patch
 * can note one id once per file, so each id keeps a queue and `take` answers the oldest.
 */
export interface LimitNotes {
  note(toolUseId: string, at: LimitAt): void;
  take(toolUseId: string): LimitAt | undefined;
}

export function createLimitNotes(): LimitNotes {
  const noted = new Map<string, LimitAt[]>();
  return {
    note(toolUseId, at) {
      const queue = noted.get(toolUseId);
      if (queue !== undefined) {
        queue.push(at);
        return;
      }
      noted.set(toolUseId, [at]);
      if (noted.size > NOTED_IDS_MAX) {
        const [oldest] = noted.keys();
        if (oldest !== undefined) noted.delete(oldest);
      }
    },
    take(toolUseId) {
      const queue = noted.get(toolUseId);
      const at = queue?.shift();
      if (queue?.length === 0) noted.delete(toolUseId);
      return at;
    },
  };
}

export interface HookJudgeContext {
  readonly projectId: ProjectId;
  readonly workstreamId: WorkstreamId | null;
  readonly taskId: TaskId | null;
  readonly fastPath: FastPathContext;
  readonly policy: TrustPolicy;
  /** The builder's approved calls and the project's grants as they are now, so a grant removed mid-session stops at once. */
  readonly allowLines: () => readonly string[];
  /** What the builder wrote on this run when they retried it or sent it back, oldest first. */
  readonly builderNotes: readonly string[];
  /** The judge of this call: only a `tendb` call is 10db's judge's. */
  readonly judgeNow: (req: JudgedCallRequest) => JudgeKind;
  /**
   * Whether the builder's own allowed commands (the project's, never a step's base list) cover the call: it is
   * settled before any judge reads it, as Claude Code's allow rule settles it on native.
   */
  readonly coveredByBuilderRule: (req: JudgedCallRequest) => boolean;
  /** The session's own answer on the `rules` floor, a lane's unattended answer and skip included. */
  readonly floorVerdict: (req: JudgedCallRequest) => GuardVerdict;
  /**
   * Reads the project's files as committed at `origin/<base>` and unchanged in the checkout, for the make targets
   * and scripts a shell call runs (`callRuns`); null shows the judge the call alone.
   */
  readonly readCommitted: CommittedReader | null;
  /** A lane's skip recorder; null where the builder is in the session. */
  readonly skips: SkipRecorder | null;
  readonly limits: LimitNotes;
  /** Told each time 10db's judge can't answer, with what it said: the thread's notice and the log. */
  readonly onFloor: (detail: string) => void;
  /** The project's precedents as they are now, in every state, read on each call so a Remove takes effect at once. */
  readonly precedents: () => readonly TrustPrecedentDto[];
  /** Whether the session runs in a separate copy, which is shown a `copy` precedent before the project's. */
  readonly inCopy: boolean;
  /** A precedent was paused by its third conflict with a limit. */
  readonly onPrecedentPaused: (id: TrustPrecedentId) => void;
  /** A precedent is shown with changed text; called once per precedent and hash in a session. */
  readonly onPrecedentChanged: (id: TrustPrecedentId, hash: string) => void;
  readonly clock: Clock;
}

const FAST_PATH_SETTLED = 'A read, an edit or a read-only command that reaches no secret';
const MODEL_SETTLED = "Allowed by 10db's judge";
const PRECEDENT_SETTLED = "Allowed by 10db's judge as routine in this project";
const RULE_SETTLED = "The builder's allow rule covers this call, so it runs, as in Claude Code.";
const GRANT_SETTLED = 'The builder allowed this very call in this project.';

const InputRecord = z.record(z.string(), z.unknown());
const NO_RUNS: CallRuns = { runs: [], cut: false, differs: false };

/**
 * The session judge for a call the guard left open, on 10db's judge: the fast path, then `crossesLimit`. An allow
 * settles the call; a limit asks the builder (attended) or is a recorded skip (a lane); a judge that can't answer
 * gives the session's rules answer, and for `FLOOR_BACKOFF_MS` after a timeout or an error asks no model. A shell
 * call is shown with the committed text of what it runs (`callRuns`). The judges' verdict on a call is kept for the
 * session, keyed by the call, the allow lines and that text, so the same call is answered the same way and a changed
 * grant or script judges it again. For `FLOOR_BACKOFF_MS` after the second opinion
 * timed out or failed, a call the first judge leaves unclear skips without asking it.
 */
export function createHookJudge(
  deps: { readonly judge: Judge; readonly state: StateStore; readonly logger: Logger },
  ctx: HookJudgeContext,
): (req: JudgedCallRequest) => Promise<GuardVerdict> {
  let downAt: { readonly ms: number; readonly detail: string } | null = null;
  let secondDownAt: number | null = null;
  const settled = new Map<string, LimitVerdict>();
  // Only a model's decisive verdict is kept: its allow, or a limit it named. The fast path reads the disk each time
  // (a link made since can lead a write to data that was there before), so its allow is never kept; nor is a call
  // the judges couldn't settle, or one a failed judge left to the rules.
  const remember = (key: string, verdict: LimitVerdict): void => {
    if (verdict.kind === 'floor' || (verdict.kind === 'limit' && verdict.at.limit === null)) return;
    if (verdict.kind === 'allow' && verdict.by === 'fast_path') return;
    settled.set(key, verdict);
    if (settled.size > SETTLED_CALLS_MAX) {
      const [oldest] = settled.keys();
      if (oldest !== undefined) settled.delete(oldest);
    }
  };

  // What a shell call runs, as committed and unchanged; a reader that fails shows the call alone.
  const runsOf = async (
    req: JudgedCallRequest,
    input: Readonly<Record<string, unknown>>,
  ): Promise<CallRuns> => {
    const command = input['command'];
    if (ctx.readCommitted === null || req.toolName !== 'Bash' || typeof command !== 'string')
      return NO_RUNS;
    try {
      const checkout = ctx.fastPath.checkout;
      return await callRuns(command, req.cwd ?? checkout, checkout, ctx.readCommitted);
    } catch {
      // Unreadable files are unverified, so no precedent is shown for the call.
      return { ...NO_RUNS, differs: true };
    }
  };

  // The package.json line a package runner's key runs, as committed: null with no such key. A file that is not the
  // base's, or can't be read, withholds the precedent instead (`withheld`).
  const packageScriptOf = async (
    key: string | null,
    cwd: string,
  ): Promise<{ readonly line: string | null; readonly withheld: boolean }> => {
    const checkout = ctx.fastPath.checkout;
    const file = key === null ? null : keyPackageFile(key, checkout, cwd);
    if (key === null || file === null) return { line: null, withheld: false };
    try {
      const read = ctx.readCommitted === null ? null : await ctx.readCommitted(file);
      return read?.kind === 'same'
        ? { line: packageScriptLine(read.text, key), withheld: false }
        : { line: null, withheld: true };
    } catch {
      return { line: null, withheld: true };
    }
  };

  // Each count is bookkeeping: a failed write must never fail the call it counts.
  const countFresh = (verdict: LimitVerdict, shown: ShownPrecedent | null): void => {
    if (shown === null) return;
    try {
      if (verdict.kind === 'allow' && verdict.by === 'precedent') {
        deps.state.write((w) => {
          countPrecedentUse(w, shown.id);
        });
        return;
      }
      if (verdict.kind !== 'limit' || verdict.precedentConflict !== true) return;
      const paused = deps.state.write((w) => {
        if (countPrecedentConflict(w, shown.id) < PRECEDENT_CONFLICTS_MAX) return false;
        return setPrecedent(w, ctx.projectId, shown.id, { state: PrecedentState.Paused }) !== null;
      });
      if (paused) ctx.onPrecedentPaused(shown.id);
    } catch (error) {
      deps.logger.warn(
        { err: error, precedentId: shown.id },
        "a precedent's count was not written",
      );
    }
  };
  const changedNoticed = new Set<string>();

  const floor = (req: JudgedCallRequest, detail: string): GuardVerdict => {
    ctx.onFloor(detail);
    deps.logger.info(
      { workstreamId: ctx.workstreamId, toolName: req.toolName, detail },
      "10db's judge didn't answer; the rules decide this call",
    );
    return ctx.floorVerdict(req);
  };

  return async (req) => {
    const judging = ctx.judgeNow(req);
    if (judging === JudgeKind.Rules) return { decision: 'allow' };
    // A question is the builder's to answer, whatever any judge thinks of it.
    if (req.toolName === 'AskUserQuestion') return { decision: 'allow' };
    const input = InputRecord.safeParse(req.input).data ?? {};
    // The builder's Always in this project on this very call settles it in the hook, ahead of Claude's auto
    // mode classifier as well as 10db's judge: the hook's allow ends the check, as Claude Code's own "don't ask
    // again" does. No judge reads the call, since it is the agent's text.
    if (isGrantedCall(projectGrantedCalls(deps.state.db, ctx.projectId), req.toolName, input))
      return { decision: 'allow', settled: GRANT_SETTLED };
    if (judging !== JudgeKind.Tendb) return { decision: 'allow' };
    if (ctx.coveredByBuilderRule(req)) return { decision: 'allow', settled: RULE_SETTLED };
    const runs = await runsOf(req, input);
    const allow = ctx.allowLines();
    // The key only picks which precedent is shown; no code path allows a call because it has one.
    const cwd = req.cwd ?? ctx.fastPath.checkout;
    const program = programKey(req.toolName, input, ctx.fastPath.checkout, cwd);
    const script = await packageScriptOf(program, cwd);
    const shown = precedentFor(
      ctx.precedents(),
      program,
      ctx.inCopy,
      runsHash(runs, script.line),
      runs.differs || script.withheld,
    );
    if (shown?.changedSince === true && shown.hash !== null) {
      const noticed = `${shown.id}:${shown.hash}`;
      if (!changedNoticed.has(noticed)) {
        changedNoticed.add(noticed);
        ctx.onPrecedentChanged(shown.id, shown.hash);
      }
    }
    const key = JSON.stringify([
      callKey(req.toolName, input, ctx.fastPath.checkout),
      // An input that is not an object reads as `{}` above, so the raw input keeps such calls apart.
      req.input,
      req.cwd,
      req.hunk,
      allow,
      ctx.builderNotes,
      // A verdict reached on a script's committed text is not one on the text the checkout holds after an edit.
      runs,
      // Approving, pausing, editing or removing a precedent judges the call afresh.
      shown,
    ]);
    const known = settled.get(key);
    const now = ctx.clock.now().getTime();
    if (known === undefined && downAt !== null && now - downAt.ms < FLOOR_BACKOFF_MS)
      return floor(req, downAt.detail);
    const verdict =
      known ??
      (await crossesLimit(
        { judge: deps.judge, state: deps.state },
        {
          call: {
            toolName: req.toolName,
            input: req.input,
            cwd: req.cwd ?? ctx.fastPath.checkout,
            hunk: req.hunk,
          },
          fastPath: ctx.fastPath,
          policy: ctx.policy,
          allow,
          notes: ctx.builderNotes,
          runs,
          ...(shown === null ? {} : { precedent: shown }),
          programKey: program,
          secondOpinion: secondDownAt === null || now - secondDownAt >= FLOOR_BACKOFF_MS,
          ...(ctx.workstreamId === null ? {} : { workstreamId: ctx.workstreamId }),
          ...(ctx.taskId === null ? {} : { taskId: ctx.taskId }),
          signal: req.signal,
        },
      ));
    remember(key, verdict);
    // Only a fresh verdict counts: one answered from memory is the same judged call, not another use.
    if (known === undefined) countFresh(verdict, shown);
    if (verdict.kind === 'limit' && verdict.secondDown !== undefined)
      secondDownAt = ctx.clock.now().getTime();
    // Only a model's fresh answer says the judge is back; a remembered verdict says nothing of it.
    if (known === undefined && verdict.kind !== 'floor') downAt = null;
    switch (verdict.kind) {
      case 'allow':
        return {
          decision: 'allow',
          settled:
            verdict.by === 'fast_path'
              ? FAST_PATH_SETTLED
              : verdict.by === 'precedent'
                ? PRECEDENT_SETTLED
                : MODEL_SETTLED,
        };
      case 'floor':
        if (verdict.reason === 'timeout' || verdict.reason === 'error')
          downAt = { ms: ctx.clock.now().getTime(), detail: verdict.detail };
        return floor(req, verdict.detail);
      case 'limit': {
        const { at } = verdict;
        if (ctx.skips === null) {
          // Without an id no card can be tied to the call, so it is refused with its reason.
          if (req.toolUseId === null)
            return { decision: 'deny', reason: at.reason, judged: { limit: at.limit } };
          ctx.limits.note(req.toolUseId, at);
          return { decision: 'ask', reason: `10db's judge asks the builder: ${at.reason}` };
        }
        ctx.skips.record({
          toolName: req.toolName,
          toolUseId: req.toolUseId,
          callKey: callKey(req.toolName, input, ctx.fastPath.checkout),
          summary: callSummary(req.toolName, input).text,
          kind: SkipKind.Classifier,
          limit: at.limit,
          reason: at.reason,
          source: SkipSource.TendbJudge,
          programKey: program,
        });
        return {
          decision: 'deny',
          reason: skipMessage(at.limit, at.reason),
          judged: { limit: at.limit },
        };
      }
    }
  };
}
