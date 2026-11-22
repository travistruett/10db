import { matchesGlob, resolve } from 'node:path';
import { BatchId, KnowledgeItemKind, Rigor, TaskId } from '@10db/contracts';
import { z } from 'zod';
import {
  AccountView,
  ActedOn,
  Adopted,
  BoardColumnView,
  HeldView,
  Imported,
  InboxItemView,
  JoinedBatches,
  KindView,
  ProjectView,
  RunNextView,
  SavedAccount,
  SavedHazards,
  StartedView,
  TaskView,
} from './api-views';
import type { Api } from './connection';
import { TendbError, UnknownCommandError } from './errors';
import { mergeHazards } from './hazards';
import {
  KnowledgeItemView,
  KnowledgeListView,
  kindOfId,
  knowledgeBody,
  knowledgeLine,
  knowledgeListPath,
  placeLabel,
  summaryOf,
} from './knowledge-commands';
import { draftProblems, patchProblems, withKindObjects } from './task-checks';

export interface CommandDeps {
  api: Api;
  out(line: string): void;
  cwd: string;
  /** Runs git; the output, or null when git fails. */
  git(args: readonly string[], cwd: string): string | null;
  /** Reads a text file; throws when it can't. */
  readFile(path: string): string;
  /** Resolves symlinks; throws when the path doesn't exist. */
  realpath(path: string): string;
}

// Only these settings keys may change here; secrets live in the Keychain and never pass through.
const ACCOUNT_SETTING_KEYS = ['awsProfile', 'region'];
const DELIVERY_LABELS: Record<string, string> = {
  pull_request: 'Open a pull request',
  local: 'Commit directly',
};

type Command = (args: readonly string[], deps: CommandDeps) => Promise<void>;

async function get<S extends z.ZodType>(
  deps: CommandDeps,
  path: string,
  schema: S,
): Promise<z.output<S>> {
  return call(deps, 'GET', path, schema);
}

async function call<S extends z.ZodType>(
  deps: CommandDeps,
  method: string,
  path: string,
  schema: S,
  body?: unknown,
): Promise<z.output<S>> {
  const raw = await deps.api(method, path, body);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new TendbError(
      `${method} ${path} answered something this skill doesn't understand: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

const projectsOf = (deps: CommandDeps) => get(deps, '/projects', z.array(ProjectView));
const tasksOf = (deps: CommandDeps, projectId: string) =>
  get(deps, `/projects/${projectId}/tasks`, z.array(TaskView));
const kindsOf = (deps: CommandDeps) => get(deps, '/kinds', z.array(KindView));
const accountsOf = (deps: CommandDeps) => get(deps, '/accounts', z.array(AccountView));

/** The version the daemon ships and its build, or nulls from a daemon too old to say. */
async function skillInfo(
  deps: CommandDeps,
): Promise<{ skillVersion: string | null; appVersion: string | null }> {
  try {
    const info = await get(
      deps,
      '/agent-skill',
      z.object({ version: z.string().nullable(), appCommit: z.string().nullable() }),
    );
    return { skillVersion: info.version, appVersion: info.appCommit };
  } catch (e) {
    if (e instanceof TendbError && e.status === 404)
      return { skillVersion: null, appVersion: null };
    throw e;
  }
}

function print(deps: CommandDeps, value: unknown): void {
  deps.out(JSON.stringify(value, null, 2));
}

/** The main checkout of the git repo holding `dir`, so a worktree resolves to its project. */
function repoRoot(deps: CommandDeps, dir: string): string | null {
  const common = deps.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)?.trim();
  if (!common) return null;
  try {
    return deps.realpath(common.endsWith('/.git') ? common.slice(0, -'/.git'.length) : common);
  } catch {
    return null;
  }
}

function realOrSelf(deps: CommandDeps, path: string): string {
  try {
    return deps.realpath(path);
  } catch {
    return path;
  }
}

const within = (dir: string, root: string): boolean => dir === root || dir.startsWith(`${root}/`);

function readJson(deps: CommandDeps, file: string): unknown {
  try {
    return JSON.parse(deps.readFile(file));
  } catch (e) {
    throw new TendbError(
      `Couldn't read ${file} as JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

function taskId(id: string | undefined, usage: string): string {
  if (!id) throw new TendbError(`usage: ${usage}`);
  if (!TaskId.safeParse(id).success) {
    throw new TendbError(`${id} isn't a task id (tsk_…). Run context to list open tasks.`);
  }
  return id;
}

function batchId(id: string | undefined, usage: string): string {
  if (!id || !BatchId.safeParse(id).success) throw new TendbError(`usage: ${usage} (bat_…)`);
  return id;
}

/** The `--dry-run` flag and the other arguments. */
function withDryRun(args: readonly string[]): { dryRun: boolean; rest: string[] } {
  return { dryRun: args.includes('--dry-run'), rest: args.filter((a) => a !== '--dry-run') };
}

async function projectById(deps: CommandDeps, id: string): Promise<ProjectView> {
  const found = (await projectsOf(deps)).find((p) => p.id === id);
  if (!found) throw new TendbError(`No project ${id}. Run context to list them.`);
  return found;
}

const context: Command = async (args, deps) => {
  const cwdFlag = args.indexOf('--cwd');
  const cwd = realOrSelf(
    deps,
    resolve(deps.cwd, (cwdFlag >= 0 ? args[cwdFlag + 1] : undefined) ?? deps.cwd),
  );
  const root = repoRoot(deps, cwd);
  const projects = await projectsOf(deps);
  const kinds = await kindsOf(deps);
  const info = await skillInfo(deps);
  const matching = projects.filter((p) => {
    const repo = realOrSelf(deps, p.repoPath);
    return repo === root || within(cwd, repo);
  });
  const shown = matching.length > 0 ? matching : projects;
  print(deps, {
    cwd,
    repo: root,
    matched: matching.length,
    projects: await Promise.all(
      shown.map(async (p) => ({
        id: p.id,
        name: p.name,
        repoPath: p.repoPath,
        areas: p.areas,
        defaultRigor: p.defaultRigor,
        openTasks: (await tasksOf(deps, p.id))
          .filter((t) => t.status === 'open')
          .map((t) => ({
            id: t.id,
            title: t.title,
            boardStatus: t.boardStatus,
            dependsOn: t.dependsOn,
            rigor: t.rigor,
            effectiveRigor: t.effectiveRigor,
            kinds: t.kinds.map((k) => k.key),
          })),
      })),
    ),
    rigors: Object.values(Rigor),
    kinds: kinds.map((k) => ({
      key: k.key,
      label: k.label,
      description: k.description,
      minimumRigor: k.minimumRigor,
    })),
    ...info,
  });
};

/** The Settings label of a project's "When checks pass" choice, which applies only under pull requests. */
function landingLabel(p: ProjectView): string {
  switch (p.landing) {
    case 'merge':
      return `Merge into ${p.baseBranch}`;
    case 'branch':
      return `Merge into ${p.landingBranch ?? 'a branch'}`;
    case 'hold':
      return 'Hold for my review';
    default:
      return p.landing;
  }
}

/** A project's settings as the builder sees them in Settings, for verifying a setup. Reads only. */
const projectSettings: Command = async ([ref], deps) => {
  if (!ref) throw new TendbError('usage: project <projectId|name>');
  const projects = await projectsOf(deps);
  const p = projects.find((x) => x.id === ref) ?? projects.find((x) => x.name === ref);
  if (!p) {
    throw new TendbError(
      `No project ${ref}. Projects: ${projects.map((x) => `${x.name} (${x.id})`).join(', ')}`,
    );
  }
  const accounts = await accountsOf(deps);
  const account = (id: string | null) => {
    if (id === null) return null;
    const a = accounts.find((x) => x.id === id);
    return a ? { id: a.id, label: a.label, kind: a.kind } : { id, label: '(no such account)' };
  };
  const info = await skillInfo(deps);
  print(deps, {
    id: p.id,
    name: p.name,
    repoPath: p.repoPath,
    gate: {
      command: p.gateCommand,
      changedCheck: p.changedCheckCommand,
      precheck: p.precheckCommand,
    },
    delivery: { mode: p.delivery, label: DELIVERY_LABELS[p.delivery] ?? p.delivery },
    baseBranch: p.baseBranch,
    landing: {
      mode: p.landing,
      label: landingLabel(p),
      branch: p.landingBranch,
      prTitlePrefix: p.prTitlePrefix,
    },
    ...(p.delivery === 'pull_request'
      ? {}
      : {
          note: 'Settings shows the base branch and landing only under "Open a pull request"; these are the stored values.',
        }),
    account: account(p.accountId),
    fallbackAccount: account(p.fallbackAccountId),
    defaultRigor: p.defaultRigor,
    maxLanes: p.maxLanes,
    workspaceMode: p.workspaceMode,
    sandbox: { loopback: p.sandboxLoopback, docker: p.sandboxDocker },
    areas: p.areas,
    hazards: p.hazards,
    ...info,
  });
};

const areas: Command = async ([id, ...paths], deps) => {
  if (!id || paths.length === 0) throw new TendbError('usage: areas <projectId> <path>...');
  const p = await projectById(deps, id);
  for (const path of paths) {
    const hits = p.areas
      .filter((a) => a.globs.some((g) => matchesGlob(path, g)))
      .map((a) => a.name);
    deps.out(`${path}\t${hits.length > 0 ? hits.join(', ') : '(no area)'}`);
  }
};

const create: Command = async (args, deps) => {
  const {
    dryRun,
    rest: [id, file],
  } = withDryRun(args);
  if (!id || !file) throw new TendbError('usage: create <projectId> <draft.json> [--dry-run]');
  const draft = readJson(deps, file);
  const p = await projectById(deps, id);
  const found = draftProblems(draft, p, await tasksOf(deps, id), await kindsOf(deps));
  if (found.length > 0) {
    throw new TendbError(`The draft doesn't fit 10db's New Task rules:\n- ${found.join('\n- ')}`);
  }
  if (dryRun) {
    deps.out(`DRY RUN: valid for project ${p.name}; would POST /projects/${id}/tasks with:`);
    print(deps, draft);
    return;
  }
  const task = await call(deps, 'POST', `/projects/${id}/tasks`, ActedOn, withKindObjects(draft));
  deps.out(`Created ${task.id} "${task.title}" in ${p.name} (${task.boardStatus ?? ''}).`);
};

const edit: Command = async (args, deps) => {
  const {
    dryRun,
    rest: [raw, file],
  } = withDryRun(args);
  const id = taskId(raw, 'edit <taskId> <patch.json> [--dry-run]');
  if (!file) throw new TendbError('usage: edit <taskId> <patch.json> [--dry-run]');
  const patch = readJson(deps, file);
  if (typeof patch === 'object' && patch !== null && Object.keys(patch).length === 0) {
    throw new TendbError('The patch changes nothing: give at least one field.');
  }
  const found = patchProblems(patch, await kindsOf(deps));
  if (found.length > 0)
    throw new TendbError(`The patch doesn't fit 10db's rules:\n- ${found.join('\n- ')}`);
  if (dryRun) {
    deps.out(`DRY RUN: would PATCH /tasks/${id} with:`);
    print(deps, patch);
    return;
  }
  const task = await call(deps, 'PATCH', `/tasks/${id}`, ActedOn, withKindObjects(patch));
  deps.out(`Updated ${task.id} "${task.title}" (${task.boardStatus ?? ''}).`);
};

const remove: Command = async ([raw], deps) => {
  const id = taskId(raw, 'remove <taskId>');
  const task = await call(deps, 'POST', `/tasks/${id}/remove`, ActedOn);
  deps.out(`Removed ${task.id} "${task.title}".`);
};

const start: Command = async ([raw], deps) => {
  const id = taskId(raw, 'start <taskId>');
  const started = await call(deps, 'POST', `/tasks/${id}/start`, StartedView);
  // A workstream answers for a direct start; a batch for a pull-request start, whose branch is cut after.
  const kind = started?.id.startsWith('bat_') ? 'batch' : 'workstream';
  deps.out(
    `Started ${id} as ${kind} ${started?.id ?? ''}. A refusal after this shows on the Board and in the Inbox.`,
  );
};

const move: Command = async ([raw, column], deps) => {
  const id = taskId(raw, 'move <taskId> <column name|state>');
  if (!column) throw new TendbError('usage: move <taskId> <column name|state>');
  let to: string | null = null;
  if (column !== 'state') {
    let projectId: string | null = null;
    for (const p of await projectsOf(deps)) {
      if ((await tasksOf(deps, p.id)).some((t) => t.id === id)) projectId = p.id;
    }
    if (!projectId) throw new TendbError(`No open task ${id}. Run context to list them.`);
    const columns = await get(
      deps,
      `/projects/${projectId}/board-columns`,
      z.array(BoardColumnView),
    );
    const found = columns.find((c) => c.name.toLowerCase() === column.toLowerCase());
    if (!found) {
      throw new TendbError(
        `No column "${column}". Columns: ${columns.map((c) => c.name).join(', ')}, or state`,
      );
    }
    to = found.id;
  }
  const task = await call(deps, 'POST', `/tasks/${id}/move`, ActedOn, {
    to,
    after: null,
    before: null,
  });
  deps.out(
    `Moved ${task.id} "${task.title}" to ${column === 'state' ? 'its state column' : column}.`,
  );
};

const inbox: Command = async (_args, deps) => {
  for (const i of await get(deps, '/inbox?state=OPEN', z.array(InboxItemView))) {
    deps.out(
      [
        i.id,
        i.kind,
        i.title.slice(0, 120),
        i.options.map((o) => o.label).join(' | ') || '(dismiss)',
      ].join('\t'),
    );
  }
};

const answer: Command = async ([id, choice, ...note], deps) => {
  if (!id || !choice) throw new TendbError('usage: answer <inboxId> <choice> [note]');
  const body = note.length > 0 ? { choice, note: note.join(' ') } : { choice };
  const item = await call(deps, 'POST', `/inbox/${id}/answer`, ActedOn, body);
  deps.out(`Answered ${item.id} "${item.title.slice(0, 80)}" with ${choice}.`);
};

const ship: Command = async ([raw], deps) => {
  const id = batchId(raw, 'ship <batchId>');
  const batch = await call(deps, 'POST', `/batches/${id}/ship`, ActedOn);
  deps.out(`Shipping ${batch.id} "${batch.title}" (${batch.state ?? ''}).`);
};

const abandon: Command = async ([raw], deps) => {
  const id = batchId(raw, 'abandon <batchId>');
  const batch = await call(deps, 'POST', `/batches/${id}/abandon`, ActedOn);
  deps.out(`Abandoned ${batch.id} "${batch.title}" (${batch.state ?? ''}).`);
};

const close: Command = async ([raw], deps) => {
  const id = taskId(raw, 'close <taskId>');
  const task = await call(deps, 'POST', `/tasks/${id}/close`, ActedOn);
  deps.out(`Closed ${task.id} "${task.title}" (${task.status ?? ''}).`);
};

const joinBatch: Command = async ([rawTask, rawBatch], deps) => {
  const id = taskId(rawTask, 'join <taskId> <batchId>');
  const batch = batchId(rawBatch, 'join <taskId> <batchId>');
  let task: TaskView | undefined;
  for (const p of await projectsOf(deps)) {
    task = (await tasksOf(deps, p.id)).find((t) => t.id === id);
    if (task) break;
  }
  if (!task) throw new TendbError(`No project has task ${id}.`);
  const batches = await call(
    deps,
    'POST',
    `/projects/${task.projectId ?? ''}/batches`,
    JoinedBatches,
    {
      title: task.title,
      taskIds: [id],
      batchId: batch,
    },
  );
  deps.out(`Started ${id} in ${batches.map((b) => `${b.id} (${b.state})`).join(', ')}.`);
};

const runNext: Command = async ([raw], deps) => {
  const id = taskId(raw, 'next <taskId>');
  const result = await call(deps, 'POST', `/tasks/${id}/run-next`, RunNextView);
  const waiting = result?.waitingOn?.length ?? 0;
  const waits = waiting > 0 ? ` It waits on ${String(waiting)} unfinished task(s) first.` : '';
  deps.out(`Put ${id} first in line.${waits}`);
};

const hold: Command = async ([raw], deps) => {
  const id = taskId(raw, 'hold <taskId>');
  const workstream = await call(deps, 'POST', `/tasks/${id}/hold`, HeldView);
  deps.out(`Held ${id} (${workstream.state}).`);
};

/** Lists a project's decisions and principles, the builder's own (All Projects) included. Reads only. */
const knowledge: Command = async ([projectId, ...flags], deps) => {
  if (!projectId) throw new TendbError('usage: knowledge <projectId> [--q <text>] [--kind ...]');
  const list = await get(deps, knowledgeListPath(projectId, flags), KnowledgeListView);
  if (list.search.message) deps.out(list.search.message);
  for (const item of list.items) deps.out(knowledgeLine(item));
  deps.out(
    `Showing ${String(list.items.length)} of ${String(list.total)} (page ${String(list.page)}, ${String(list.pageSize)} a page).`,
  );
};

/** Records a decision or a principle; the same command shape for both, `kind` naming the route. */
function record(kind: KnowledgeItemKind): Command {
  const usage = `usage: ${kind} <projectId> <${kind}.json> [--dry-run]`;
  return async (args, deps) => {
    const {
      dryRun,
      rest: [projectId, file],
    } = withDryRun(args);
    if (!projectId || !file) throw new TendbError(usage);
    const body = knowledgeBody('write', kind, readJson(deps, file), deps.cwd, dryRun);
    const p = await projectById(deps, projectId);
    const path = `/projects/${projectId}/${kind}s`;
    if (dryRun) {
      const result = await call(deps, 'POST', path, z.unknown(), body);
      deps.out(`DRY RUN: valid for ${p.name}; would POST ${path}, which answers:`);
      print(deps, result);
      return;
    }
    const item = await call(deps, 'POST', path, KnowledgeItemView, body);
    deps.out(`Recorded ${kind} ${item.id} (${placeLabel(item)}): ${summaryOf(item)}`);
    if (item.supersedesId) deps.out(`It replaced ${item.supersedesId}, now superseded.`);
  };
}

/** Replaces a current decision or principle with a changed copy; the id's prefix says which route. */
const supersede: Command = async (args, deps) => {
  const {
    dryRun,
    rest: [id, file],
  } = withDryRun(args);
  const usage = 'usage: supersede <decisionId|principleId> <changes.json> [--dry-run]';
  if (!id || !file) throw new TendbError(usage);
  const kind = kindOfId(id);
  if (!kind) {
    throw new TendbError(`${id} isn't a decision or principle id (dec_… or pri_…). ${usage}`);
  }
  const body = knowledgeBody('edit', kind, readJson(deps, file), deps.cwd, dryRun);
  const path = `/${kind}s/${id}/supersede`;
  if (dryRun) {
    const result = await call(deps, 'POST', path, z.unknown(), body);
    deps.out(`DRY RUN: valid; would POST ${path}, which answers:`);
    print(deps, result);
    return;
  }
  const item = await call(deps, 'POST', path, KnowledgeItemView, body);
  deps.out(`Superseded ${id} with ${item.id} (${placeLabel(item)}, ${kind}).`);
};

const resaveAccount: Command = async (args, deps) => {
  const label = args.join(' ');
  if (!label) throw new TendbError('usage: resave-account <account label>');
  const account = (await accountsOf(deps)).find((a) => a.label === label);
  if (!account) throw new TendbError(`No account is labelled ${label}.`);
  await call(deps, 'PATCH', `/accounts/${account.id}`, z.unknown(), { label: account.label });
  deps.out(`Saved ${account.id} "${account.label}" unchanged.`);
};

const accountSettings: Command = async ([file, ...labelWords], deps) => {
  const label = labelWords.join(' ');
  if (!file || !label) throw new TendbError('usage: account-settings <patch.json> <account label>');
  const patch = readJson(deps, file);
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TendbError('The patch must be a JSON object.');
  }
  const refused = Object.keys(patch).filter((k) => !ACCOUNT_SETTING_KEYS.includes(k));
  if (refused.length > 0) {
    throw new TendbError(
      `Only ${ACCOUNT_SETTING_KEYS.join(', ')} can change here, not ${refused.join(', ')}.`,
    );
  }
  const account = (await accountsOf(deps)).find((a) => a.label === label);
  if (!account) throw new TendbError(`No account is labelled ${label}.`);
  const settings = { ...account.settings, ...patch };
  const saved = await call(deps, 'PATCH', `/accounts/${account.id}`, SavedAccount, { settings });
  deps.out(
    `Saved ${account.id} "${account.label}" settings: ${JSON.stringify(saved.settings ?? settings)}`,
  );
};

const goal: Command = async (args, deps) => {
  const {
    dryRun,
    rest: [id, file],
  } = withDryRun(args);
  if (!id || !file) throw new TendbError('usage: goal <projectId> <brief.md> [--dry-run]');
  let text: string;
  try {
    text = deps.readFile(file);
  } catch (e) {
    throw new TendbError(`Couldn't read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const p = await projectById(deps, id);
  if (dryRun) {
    const result = await call(deps, 'POST', `/projects/${id}/goals/adopt`, z.unknown(), {
      text,
      dryRun,
    });
    deps.out(`DRY RUN: the brief is valid for project ${p.name}; adopting it would write:`);
    print(deps, result);
    return;
  }
  const result = await call(deps, 'POST', `/projects/${id}/goals/adopt`, Adopted, { text, dryRun });
  deps.out(`Adopted goal ${result.id} "${result.title}" in ${p.name}.`);
  print(deps, result);
};

const planImport: Command = async (args, deps) => {
  const {
    dryRun,
    rest: [id, file],
  } = withDryRun(args);
  if (!id || !file)
    throw new TendbError('usage: plan-import <projectId> <bundle.json> [--dry-run]');
  let bundlePath: string;
  try {
    bundlePath = deps.realpath(file);
  } catch (e) {
    throw new TendbError(`Couldn't find ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const p = await projectById(deps, id);
  if (dryRun) {
    const result = await call(deps, 'POST', `/projects/${id}/plans/import`, z.unknown(), {
      bundlePath,
      dryRun,
    });
    deps.out(`DRY RUN: the bundle is valid for project ${p.name}; importing it would write:`);
    print(deps, result);
    return;
  }
  const result = await call(deps, 'POST', `/projects/${id}/plans/import`, Imported, {
    bundlePath,
    dryRun,
  });
  deps.out(
    `${result.created ? 'Imported a new Plan' : 'Re-imported Plan'} ${result.shapeId} into ${p.name}.`,
  );
  print(deps, result);
};

/** Prints a project's hazards, or adds to them (add-only; see `mergeHazards`). */
const hazards: Command = async (args, deps) => {
  const {
    dryRun,
    rest: [id, file],
  } = withDryRun(args);
  if (!id) throw new TendbError('usage: hazards <projectId> [additions.json] [--dry-run]');
  const p = await projectById(deps, id);
  if (!file) {
    print(deps, p.hazards);
    return;
  }
  const tracked = deps.git(['ls-files', '-z'], p.repoPath);
  const { merged, report } = mergeHazards(
    p,
    readJson(deps, file),
    tracked === null ? null : tracked.split('\0').filter(Boolean),
  );
  if (report.length === 0) {
    deps.out(`Nothing to add: ${p.name}'s hazards already hold every entry.`);
    return;
  }
  deps.out(
    `${dryRun ? 'DRY RUN: would add' : 'Adding'} to ${p.name}'s hazards:\n${report.join('\n')}`,
  );
  if (dryRun) return;
  const saved = await call(deps, 'PATCH', `/projects/${id}`, SavedHazards, { hazards: merged });
  deps.out(`Saved. ${p.name} now has ${String(saved.hazards.length)} hazards.`);
};

const COMMANDS: Record<string, Command> = {
  context,
  project: projectSettings,
  areas,
  create,
  goal,
  'plan-import': planImport,
  knowledge,
  decision: record(KnowledgeItemKind.Decision),
  principle: record(KnowledgeItemKind.Principle),
  supersede,
  edit,
  remove,
  start,
  move,
  inbox,
  answer,
  ship,
  abandon,
  close,
  join: joinBatch,
  next: runNext,
  hold,
  hazards,
  'resave-account': resaveAccount,
  'account-settings': accountSettings,
};

const USAGE =
  'usage: node tendb.mjs context|project|areas|create|goal|plan-import|knowledge|decision|principle|supersede|edit|remove|start|move|inbox|answer|ship|abandon|close|join|next ... (commands and arguments: SKILL.md beside this file)';

/** Runs one command line, as `node tendb.mjs <argv>` does. */
export async function runCommand(argv: readonly string[], deps: CommandDeps): Promise<void> {
  const [name, ...rest] = argv;
  const run = name === undefined ? undefined : COMMANDS[name];
  if (!run) throw new UnknownCommandError(USAGE);
  await run(rest, deps);
}
