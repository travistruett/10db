import {
  QuestionCategory,
  Urgency,
  InboxKind,
  type PlaybookMoveEntry,
  type ProjectId,
} from '@10db/contracts';
import {
  getAppSetting,
  getProject,
  insertInboxItem,
  listKinds,
  patchKind,
  patchProject,
  patchTask,
  readLegacyRouting,
  setAppSetting,
  setPlaybook,
  type WriteContext,
} from '@10db/db';
import { moveCells } from './move-cells';
import type { ScopedMoveEntry } from './move-entries';
import { movePatterns } from './move-patterns';
import { moveRigor } from './move-tasks';

/** The app setting that records today's settings were moved, so the move happens once. */
export const PLAYBOOK_MOVED_KEY = 'playbook.moved';
/** The app setting that holds the global entries of the move's report, for Settings › Models. */
export const PLAYBOOK_MOVE_REPORT_KEY = 'playbook.moveReport';

/** What the move could not carry over: the global entries, and each affected project's. */
export interface MoveReport {
  readonly global: readonly PlaybookMoveEntry[];
  readonly projects: readonly {
    readonly projectId: ProjectId;
    readonly entries: readonly PlaybookMoveEntry[];
  }[];
}

const NOTHING: MoveReport = { global: [], projects: [] };

const plain = ({ setting, value, why }: ScopedMoveEntry): PlaybookMoveEntry => ({
  setting,
  value,
  why,
});

function reportOf(entries: readonly ScopedMoveEntry[]): MoveReport {
  const byProject = new Map<ProjectId, PlaybookMoveEntry[]>();
  for (const entry of entries) {
    if (entry.projectId === null) continue;
    byProject.set(entry.projectId, [...(byProject.get(entry.projectId) ?? []), plain(entry)]);
  }
  return {
    global: entries.filter((e) => e.projectId === null).map(plain),
    projects: [...byProject].map(([projectId, list]) => ({ projectId, entries: list })),
  };
}

const lines = (entries: readonly PlaybookMoveEntry[]): string =>
  entries.map((e) => `• ${e.setting}: ${e.value}. ${e.why}.`).join('\n');

/**
 * Moves the routing settings made before the playbook into it, once, in the caller's transaction, reading
 * them only through `readLegacyRouting`: flows and risk tags become rigor and kinds, role settings, team
 * bindings, persona pins and minimums become cells, and global patterns on risk tags become kind overrides.
 * What has no place in the playbook is reported: a project's entries on one Inbox card each, the global ones
 * in an app setting. The old tables are left as they are.
 */
export function moveToPlaybook(ctx: WriteContext): MoveReport {
  if (getAppSetting(ctx.tx, PLAYBOOK_MOVED_KEY) === true) return NOTHING;
  const legacy = readLegacyRouting(ctx.tx);
  const kinds = listKinds(ctx.tx);
  const cells = moveCells(legacy);
  const patterns = movePatterns(legacy.patterns, kinds);
  const rigor = moveRigor(legacy, kinds);

  if (cells.global.cells?.length) setPlaybook(ctx, null, cells.global);
  for (const { projectId, input } of cells.projects) setPlaybook(ctx, projectId, input);
  for (const [key, overrides] of patterns.overrides) {
    const kind = kinds.find((k) => k.key === key);
    if (kind) patchKind(ctx, kind.id, { overrides });
  }
  for (const { projectId, rigor: defaultRigor } of rigor.projects)
    patchProject(ctx, projectId, { defaultRigor });
  for (const task of rigor.tasks)
    patchTask(ctx, task.taskId, {
      ...(task.rigor === null ? {} : { rigor: task.rigor }),
      kinds: [...task.kinds],
    });

  const report = reportOf([...cells.entries, ...patterns.entries, ...rigor.entries]);
  for (const { projectId, entries } of report.projects) {
    const name = getProject(ctx.tx, projectId).name;
    insertInboxItem(ctx, {
      projectId,
      kind: InboxKind.PlaybookMoveReport,
      title: `${name}: some model settings did not carry over`,
      body: [
        'The rigor and playbook settings replace the old flows, patterns and role settings. These had no place in them:',
        lines(entries),
      ].join('\n'),
      options: [],
      recommendation: null,
      category: QuestionCategory.Other,
      urgency: Urgency.Normal,
      detail: null,
      foldKey: `playbook-move-report:${projectId}`,
      targets: [],
    });
  }
  setAppSetting(ctx, PLAYBOOK_MOVE_REPORT_KEY, [...report.global]);
  setAppSetting(ctx, PLAYBOOK_MOVED_KEY, true);
  return report;
}
