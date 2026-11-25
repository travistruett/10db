import { z } from 'zod';
import { SkippedActionId, WorkstreamId } from './ids';
import { LimitName } from './trust-policy';

// Trust line §5: what an unattended lane skipped instead of waiting on the builder, recorded per
// call, and how the builder can clear each kind afterwards.

type ValueOf<T> = T[keyof T];

/** What told the lane to skip a call, or answered a question for it. */
export const SkipSource = {
  AutoMode: 'auto_mode',
  SafetyCheck: 'safety_check',
  Guard: 'guard',
  Broker: 'broker',
  HostJudge: 'host_judge',
  Question: 'question',
  /** 10db's own judge; reserved, and judged as `rules` until it has values. */
  TendbJudge: 'tendb_judge',
} as const;
export type SkipSource = ValueOf<typeof SkipSource>;

/** What was skipped: each of the guard's ask kinds, and every other card a lane could have raised. */
export const SkipKind = {
  WebOrMcp: 'web_or_mcp',
  UnknownTool: 'unknown_tool',
  MonitorSocket: 'monitor_socket',
  MonitorNoCommand: 'monitor_no_command',
  ReadOutside: 'read_outside',
  SecretRead: 'secret_read',
  ConfigWrite: 'config_write',
  EditorConfigWrite: 'editor_config_write',
  HomeRcWrite: 'home_rc_write',
  UnreadEditPath: 'unread_edit_path',
  EndlessLoop: 'endless_loop',
  UnreadHazard: 'unread_hazard',
  /** A pass's commit, push or merge, which the builder allows on a card when there. */
  PassGit: 'pass_git',
  Deploy: 'deploy',
  DockerOff: 'docker_off',
  Escalation: 'escalation',
  DefaultModeCard: 'default_mode_card',
  HazardCard: 'hazard_card',
  Classifier: 'classifier',
  SafetyCheck: 'safety_check',
  Host: 'host',
  /** A shell call whose program sits outside what the lane may read, so the lane's profile can't run it. */
  CantRunInLane: 'cant_run_in_lane',
  Question: 'question',
} as const;
export type SkipKind = ValueOf<typeof SkipKind>;

/**
 * How Run these now clears a skip: an allow line read by intent, the exact call matched by its key,
 * a host seeded into the run, or not at all.
 */
export const Approval = {
  Intent: 'intent',
  Exact: 'exact',
  SeedHost: 'seed_host',
  None: 'none',
} as const;
export type Approval = ValueOf<typeof Approval>;

/** The most of a call a skip keeps as its summary, in UTF-16 units. */
export const SKIP_SUMMARY_MAX = 500;

export const SkippedActionDto = z.object({
  id: SkippedActionId,
  workstreamId: WorkstreamId,
  toolName: z.string().min(1),
  summary: z.string().max(SKIP_SUMMARY_MAX + 1),
  kind: z.enum(SkipKind),
  /** The limit it would have crossed; null when the judge named none, as the classifier never does. */
  limit: z.enum(LimitName).nullable(),
  reason: z.string(),
  source: z.enum(SkipSource),
  approval: z.enum(Approval),
  /** The program the shell call runs, as `trust/program-key.ts` names it; null for a call with no key. */
  programKey: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type SkippedActionDto = z.infer<typeof SkippedActionDto>;

/**
 * How each kind is cleared: the classifier's denials by intent; the guard's and the broker's asks a
 * person may clear by their exact call; a refused host by seeding it into the run; the rest not at
 * all, since the builder clears them elsewhere (a switch, a claim, the editor). A call whose summary
 * was cut is never approvable, whatever its kind: the builder never saw all of it.
 */
export function approvalOf(kind: SkipKind, summaryCut: boolean): Approval {
  if (summaryCut) return Approval.None;
  switch (kind) {
    case SkipKind.Classifier:
      return Approval.Intent;
    case SkipKind.Escalation:
    case SkipKind.DefaultModeCard:
    case SkipKind.Deploy:
    case SkipKind.WebOrMcp:
    case SkipKind.UnknownTool:
    case SkipKind.MonitorSocket:
    case SkipKind.ReadOutside:
    case SkipKind.EndlessLoop:
      return Approval.Exact;
    case SkipKind.Host:
      return Approval.SeedHost;
    case SkipKind.ConfigWrite:
    case SkipKind.DockerOff:
    case SkipKind.SecretRead:
    case SkipKind.EditorConfigWrite:
    case SkipKind.HomeRcWrite:
    case SkipKind.UnreadHazard:
    case SkipKind.PassGit:
    case SkipKind.HazardCard:
    case SkipKind.MonitorNoCommand:
    case SkipKind.UnreadEditPath:
    case SkipKind.SafetyCheck:
    case SkipKind.CantRunInLane:
    case SkipKind.Question:
      return Approval.None;
  }
}
