import { z } from 'zod';
import { InboxItemId, ProjectId, TrustGrantId, TrustPrecedentId } from './ids';
import { TrustSwitches } from './trust';

type ValueOf<T> = T[keyof T];

/** The four limits every judge holds a session to (trust line §2). */
export const LimitName = {
  DestroysData: 'destroys_data',
  SendsDataOut: 'sends_data_out',
  ReadsSecrets: 'reads_secrets',
  WritesLive: 'writes_live',
} as const;
export type LimitName = ValueOf<typeof LimitName>;

/** Where a session runs: a lane and a pass do the work, Plan and chat talk it through. */
export const TrustSurface = { Lane: 'lane', Pass: 'pass', Plan: 'plan', Chat: 'chat' } as const;
export type TrustSurface = ValueOf<typeof TrustSurface>;

/** One rule of the policy: a short label, as Claude Code's own rules lead with, then the sentence. */
export const PolicyLine = z.strictObject({ label: z.string().min(1), text: z.string().min(1) });
export type PolicyLine = z.infer<typeof PolicyLine>;

export const LimitLine = PolicyLine.extend({ name: z.enum(LimitName) });
export type LimitLine = z.infer<typeof LimitLine>;

/**
 * What one session is held to, whoever judges it: the four limits, the environment the judge reads
 * them in, the coordination lines of its surface, and whether a person is in the session.
 */
export const TrustPolicy = z.strictObject({
  surface: z.enum(TrustSurface),
  attended: z.boolean(),
  limits: z.array(LimitLine).length(4),
  environment: z.array(z.string().min(1)),
  coordination: z.array(PolicyLine),
  /** What grants allow past a limit; empty until grants exist. */
  allow: z.array(z.string().min(1)),
  /**
   * The builder's standing approvals as context lines for Claude's auto mode, at most 30.
   * Only the auto mode rendering reads them: they are never an allow line and never part of `environment`, which
   * 10db's judge copies into its state.
   */
  autoModePrecedents: z.array(z.string().min(1)).max(30).default([]),
  switches: TrustSwitches,
});
export type TrustPolicy = z.infer<typeof TrustPolicy>;

export const LIVE_SYSTEM_MAX_CHARS = 200;
export const LIVE_SYSTEMS_MAX = 50;

/**
 * A host, cloud profile or namespace the judge treats as live. One line: no control, format (a
 * right-to-left override, a zero-width space) or line-separator character, and never `$defaults`, which would splice Claude Code's own rules into a rendered list.
 */
export const LiveSystem = z
  .string()
  .trim()
  .min(1)
  .max(LIVE_SYSTEM_MAX_CHARS, {
    message: `A live system is at most ${String(LIVE_SYSTEM_MAX_CHARS)} characters`,
  })
  .regex(/^[^\p{Cc}\p{Cf}\u2028\u2029]+$/u, {
    message: 'A live system is one line, with no control or format characters',
  })
  .refine((s) => !s.includes('$defaults'), { message: 'A live system cannot name $defaults' });
export type LiveSystem = z.infer<typeof LiveSystem>;

/** `GET|PUT /projects/:projectId/live-systems`. */
export const LiveSystemsDto = z.strictObject({
  liveSystems: z.array(LiveSystem).max(LIVE_SYSTEMS_MAX, {
    message: `A project has at most ${String(LIVE_SYSTEMS_MAX)} live systems`,
  }),
});
export type LiveSystemsDto = z.infer<typeof LiveSystemsDto>;

/** Where in the repo a proposed production system was read. */
export const ProductionSource = z.strictObject({ path: z.string(), line: z.number().int().min(1) });
export type ProductionSource = z.infer<typeof ProductionSource>;

/** `GET /projects/:projectId/live-systems/proposals`: entries read from the repo, each with where, not yet listed. */
export const LiveSystemProposalsDto = z.strictObject({
  proposals: z.array(z.strictObject({ entry: LiveSystem, source: ProductionSource })),
});
export type LiveSystemProposalsDto = z.infer<typeof LiveSystemProposalsDto>;

/** The longest a grant's target may be. */
export const GRANT_TARGET_MAX = 500;

/**
 * What a grant allows, as one line every judge reads: the builder's note, or the call in quotes. No control,
 * format or line-separator character, as a live system, so it can't add a list entry or hide text, and never
 * `$defaults`, which would splice Claude Code's own rules in.
 */
export const GrantTarget = z
  .string()
  .trim()
  .min(1)
  .max(GRANT_TARGET_MAX)
  .regex(/^[^\p{Cc}\p{Cf}\u2028\u2029]+$/u, {
    message: 'A grant is one line, with no control or format characters',
  })
  .refine((s) => !s.includes('$defaults'), { message: 'A grant cannot name $defaults' });
export type GrantTarget = z.infer<typeof GrantTarget>;

/** A call the builder allowed in a project from now on (Always in this project): `GET /projects/:projectId/trust-grants`. */
export const TrustGrantDto = z.strictObject({
  id: TrustGrantId,
  projectId: ProjectId,
  /** The limit the card named; null when it named none (an escalation, or a call 10db's judge wasn't sure of). */
  limit: z.enum(LimitName).nullable(),
  target: GrantTarget,
  createdAt: z.iso.datetime(),
});
export type TrustGrantDto = z.infer<typeof TrustGrantDto>;

/** Where a precedent holds: `project` covers every session of the project, copies too; `copy` only sessions in a separate copy. */
export const PrecedentScope = { Copy: 'copy', Project: 'project' } as const;
export type PrecedentScope = ValueOf<typeof PrecedentScope>;

/** `declined` is the builder's Keep Skipping; `paused` is three conflicts with a limit. */
export const PrecedentState = {
  Active: 'active',
  Paused: 'paused',
  Declined: 'declined',
  Revoked: 'revoked',
} as const;
export type PrecedentState = ValueOf<typeof PrecedentState>;

/** The builder's answer to one kind on the proposal card. */
export const PrecedentChoice = {
  Approve: 'approve',
  KeepSkipping: 'keep_skipping',
  Report: 'report',
} as const;
export type PrecedentChoice = ValueOf<typeof PrecedentChoice>;

export const PRECEDENT_KIND_MAX = 200;
export const PRECEDENT_EXAMPLE_MAX = 200;
export const PRECEDENT_EXAMPLES_MAX = 5;
export const PROGRAM_KEY_MAX = 300;

/**
 * One line: no control, format, line-separator (Zl, U+2028 only) or paragraph-separator (Zp, U+2029 only)
 * character, the same class `GrantTarget` refuses.
 */
const ONE_LINE = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;
/** A run of the characters `ONE_LINE` refuses. */
const NOT_ONE_LINE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/**
 * What a precedent covers, as one line every judge reads: the builder's words. One line as a grant, and never
 * `$defaults`.
 */
export const PrecedentKind = z
  .string()
  .trim()
  .min(1)
  .max(PRECEDENT_KIND_MAX, {
    message: `A kind is at most ${String(PRECEDENT_KIND_MAX)} characters`,
  })
  .regex(ONE_LINE, {
    message: 'A kind is one line, with no control or format characters',
  })
  .refine((s) => !s.includes('$defaults'), { message: 'A kind cannot name $defaults' });
export type PrecedentKind = z.infer<typeof PrecedentKind>;

/** A call the builder saw when approving a precedent: the agent's text, one line, shown and never run. */
export const PrecedentExample = z
  .string()
  .trim()
  .min(1)
  .max(PRECEDENT_EXAMPLE_MAX, {
    message: `An example is at most ${String(PRECEDENT_EXAMPLE_MAX)} characters`,
  })
  .regex(ONE_LINE, {
    message: 'An example is one line, with no control or format characters',
  })
  .refine((s) => !s.includes('$defaults'), { message: 'An example cannot name $defaults' });
export type PrecedentExample = z.infer<typeof PrecedentExample>;

/**
 * Fits raw call summaries to what a precedent stores as its examples, and never throws: drops any that names
 * `$defaults`, turns each run of control, format or line-separator characters into one space, trims, cuts to
 * `PRECEDENT_EXAMPLE_MAX`, keeps those `PrecedentExample` accepts, and keeps the first `PRECEDENT_EXAMPLES_MAX`.
 * A run becomes a space rather than nothing, so the fit can't join two halves into `$defaults`; fitting a fitted
 * list changes nothing. An example is shown to a judge and the builder only, never run, so one cut mid-command
 * is fine.
 */
export function fitPrecedentExamples(raw: readonly string[]): string[] {
  const fitted: string[] = [];
  for (const example of raw) {
    if (fitted.length >= PRECEDENT_EXAMPLES_MAX) break;
    if (example.includes('$defaults')) continue;
    const line = example.replace(NOT_ONE_LINE, ' ').trim().slice(0, PRECEDENT_EXAMPLE_MAX);
    const parsed = PrecedentExample.safeParse(line);
    if (parsed.success) fitted.push(parsed.data);
  }
  return fitted;
}

/** A program key: the program a shell call runs, as `trust/program-key.ts` names it. */
export const ProgramKey = z
  .string()
  .trim()
  .min(1)
  .max(PROGRAM_KEY_MAX, {
    message: `A program key is at most ${String(PROGRAM_KEY_MAX)} characters`,
  })
  .regex(ONE_LINE, {
    message: 'A program key is one line, with no control or format characters',
  })
  .refine((s) => !s.includes('$defaults'), { message: 'A program key cannot name $defaults' });
export type ProgramKey = z.infer<typeof ProgramKey>;

/** A standing approval of a kind of command in a project, which every judge weighs and none reads as a limit's clearance. */
export const TrustPrecedentDto = z.object({
  id: TrustPrecedentId,
  projectId: ProjectId,
  programKey: ProgramKey,
  scope: z.enum(PrecedentScope),
  kind: PrecedentKind,
  examples: z.array(PrecedentExample).max(PRECEDENT_EXAMPLES_MAX),
  runsHash: z.string().nullable(),
  state: z.enum(PrecedentState),
  uses: z.number().int(),
  lastUsedAt: z.string().nullable(),
  conflicts: z.number().int(),
  sourceInboxId: InboxItemId.nullable(),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
});
export type TrustPrecedentDto = z.infer<typeof TrustPrecedentDto>;

/** A kind the judge keeps doubting, offered on the proposal card. Its examples are raw skip summaries, fitted on approval. */
export const PrecedentCandidateDto = z.object({
  programKey: z.string(),
  scope: z.enum(PrecedentScope),
  kind: z.string(),
  examples: z.array(z.string()),
  runs: z.string().nullable(),
  runsHash: z.string().nullable(),
  skips: z.number().int(),
  runCount: z.number().int(),
  taskCount: z.number().int(),
  topWorry: z.object({ limit: z.enum(LimitName), p: z.number() }).nullable(),
  stoppedAtLimit: z.array(z.string()),
});
export type PrecedentCandidateDto = z.infer<typeof PrecedentCandidateDto>;

/** `POST /projects/:projectId/precedents/answer`. */
export const PrecedentAnswer = z.object({
  kinds: z
    .array(
      z.object({
        programKey: z.string().min(1),
        scope: z.enum(PrecedentScope),
        choice: z.enum(PrecedentChoice),
        kind: PrecedentKind.optional(),
      }),
    )
    .min(1)
    .max(50),
});
export type PrecedentAnswer = z.infer<typeof PrecedentAnswer>;

/** `PATCH /projects/:projectId/precedents/:precedentId`. */
export const PrecedentPatch = z.object({
  /** `active` approves again, from any state. */
  state: z.enum([PrecedentState.Active, PrecedentState.Revoked]).optional(),
  kind: PrecedentKind.optional(),
  /** Keep on the changed-script notice. */
  runsHash: z.string().optional(),
});
export type PrecedentPatch = z.infer<typeof PrecedentPatch>;

/** A call a precedent allowed, newest first. */
export const PrecedentAllowedCall = z.object({ call: z.string(), at: z.string() });
export type PrecedentAllowedCall = z.infer<typeof PrecedentAllowedCall>;

/** `GET /projects/:projectId/precedents`: every precedent in every state, and the kinds on offer. */
export const ProjectPrecedentsDto = z.object({
  precedents: z.array(
    TrustPrecedentDto.extend({ lastAllowed: z.array(PrecedentAllowedCall).max(5) }),
  ),
  candidates: z.array(PrecedentCandidateDto),
});
export type ProjectPrecedentsDto = z.infer<typeof ProjectPrecedentsDto>;
