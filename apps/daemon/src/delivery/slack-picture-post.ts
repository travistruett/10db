import { readFile } from 'node:fs/promises';
import {
  NotFoundError,
  ScreenKind,
  TaskId,
  TaskStatus,
  Urgency,
  type InboxItemId,
  type PassId,
  type ProjectDto,
  type ProjectId,
  type TaskDto,
} from '@10db/contracts';
import {
  findOpenByFoldKey,
  getAppSetting,
  getPass,
  getProject,
  getTask,
  getTaskScreenRow,
  listOpenByFoldKeyPrefix,
  listProjects,
  listTasks,
  listTaskScreens,
  setAppSetting,
  type Json,
} from '@10db/db';
import { CardTier } from '../inbox';
import { SlackError, SlackFailure, type SlackClient } from '../slack';
import { raise, type DeliveryContext } from './context';
import { signedOffTasks } from './pass-signed-off';
import { picturePlan } from './pr-pictures';
import { passPostText, taskPostText } from './slack-picture-text';
import { noFacts, postLinkOf, taskPostFacts, type TaskPostFacts } from './slack-task-facts';

// Decision 2026-11-23-a-projects-pictures-can-go-to-its-slack-channel: with the project's setting on,
// a pass's pull request is announced once in its channel with the signed-off pages' before and after
// pictures, and a finished task outside a pass is announced once per after picture with its own. A post
// never delays or fails what it reports: it runs detached and, when it fails, leaves one Inbox item.
// Its words are `slack-picture-text.ts`'s (decisions/2026-11-26-a-slack-pictures-post-links-its-issue-and-says-how-it-went.md).

/** The most files one message carries; the rest are in the pull request. */
const MAX_SLACK_PICTURES = 10;

/** Where a project's pictures go, when its setting is on and its workspace is still the one the channel was picked in. */
interface PictureChannel {
  readonly teamId: string;
  readonly channelId: string;
  /** When sharing was turned on; a task's pictures are posted only from then, and never with none. */
  readonly enabledAt: string | null;
}

export interface SlackPicturePostDeps extends Pick<DeliveryContext, 'state' | 'inbox' | 'logger'> {
  /** The project's channel; null when sharing is off, has no channel, or Slack is not connected for it. */
  readonly channelOf: (projectId: ProjectId) => PictureChannel | null;
  /** The client of a signed-in workspace; null when there is none. */
  readonly clientFor: (teamId: string) => SlackClient | null;
  /** Why a finished task that names a page has no pictures, or null; said once in the channel. */
  readonly skipped: (taskId: TaskId) => string | null;
}

export interface PassSlackPost {
  /** Posts the pass's pictures for this pull request unless it was posted or one is in flight. Never throws, never waits. */
  announce(passId: PassId, url: string): void;
}

export interface SlackPicturePost extends PassSlackPost {
  /**
   * Posts a finished task's before and after pictures unless its newest after was posted or a post
   * for it is in flight. Never throws, never waits.
   */
  announceTask(taskId: TaskId): void;
  /** Tries again each task whose post was refused, one at a time; a project's run stops at its first failure. */
  retryTasks(): Promise<void>;
  /** Announces each task without a pass, done since `sinceMs`, whose newest after was not posted. */
  catchUp(sinceMs: number): void;
}

const postedSetting = (projectId: ProjectId): string => `slack-pictures-posted.${projectId}`;
const FOLD_PREFIX = 'pictures-to-slack:';
const foldKeyOf = (id: PassId | TaskId): string => `${FOLD_PREFIX}${id}`;

/** What was posted, by pass (its pull request's URL) or by task (its newest after picture's id): a repeat posts nothing. */
function marksOf(
  db: SlackPicturePostDeps['state']['db'],
  projectId: ProjectId,
): Record<string, Json> {
  const all = getAppSetting(db, postedSetting(projectId));
  return typeof all === 'object' && all !== null && !Array.isArray(all) ? all : {};
}

/** Slack's reason, in the builder's words. */
function reasonOf(error: unknown): string {
  if (error instanceof SlackError) {
    switch (error.code) {
      case SlackFailure.MissingScope:
        return 'the Slack app lacks a scope it needs (files:write, channels:read, groups:read or channels:join): add the scopes, reinstall the app, then Replace Token on the Slack card in Settings › Integrations';
      case SlackFailure.ChannelNotFound:
        return 'the channel is private and @10db is not in it, or it is gone: invite @10db to the channel, or pick another in Settings › Sharing';
      default:
        return `Slack answered "${error.code}"`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

/** What a task's mark holds once its skipped pictures were said; an after's id replaces it when one is posted. */
const SKIPPED_MARK = 'skipped';

/** The message's cut: how many pictures did not fit in it. */
const moreOf = (planned: number): number => planned - MAX_SLACK_PICTURES;

/** Joins a public channel the bot is not in; a private one it is not in can't be joined. Uploads the files. */
async function uploadToChannel(
  client: SlackClient,
  channelId: string,
  comment: string,
  files: readonly { name: string; bytes: Uint8Array }[],
): Promise<void> {
  const channel = (await client.listChannels()).find((c) => c.id === channelId);
  if (channel === undefined)
    throw new SlackError('conversations.list', SlackFailure.ChannelNotFound);
  if (!channel.isMember) {
    if (channel.isPrivate) throw new SlackError('conversations.join', SlackFailure.ChannelNotFound);
    await client.joinChannel(channel.id);
  }
  await client.uploadFiles({ channelId: channel.id, comment, files: [...files] });
}

export function createSlackPicturePost(deps: SlackPicturePostDeps): SlackPicturePost {
  /** Passes with a post under way: a sign-off during an upload never posts twice. */
  const posting = new Set<PassId>();
  /** Tasks with a post under way. */
  const postingTasks = new Set<TaskId>();

  /** The files of the first `MAX_SLACK_PICTURES` pictures; one gone from the store is left out. */
  async function readFiles(
    planned: readonly { name: string; screen: { id: Parameters<typeof getTaskScreenRow>[1] } }[],
  ): Promise<{ name: string; bytes: Uint8Array }[]> {
    const files: { name: string; bytes: Uint8Array }[] = [];
    for (const picture of planned.slice(0, MAX_SLACK_PICTURES)) {
      try {
        files.push({
          name: picture.name,
          bytes: await readFile(getTaskScreenRow(deps.state.db, picture.screen.id).storedPath),
        });
      } catch {
        // A picture gone from the store is left out of the message.
      }
    }
    return files;
  }

  async function post(passId: PassId, url: string): Promise<void> {
    const pass = getPass(deps.state.db, passId);
    const project = getProject(deps.state.db, pass.projectId);
    const target = deps.channelOf(project.id);
    if (target === null) return;
    const client = deps.clientFor(target.teamId);
    if (client === null) return;
    const tasks = signedOffTasks(deps.state.db, passId);
    const plan = picturePlan(
      tasks.map((task) => ({
        title: task.title,
        screens: listTaskScreens(deps.state.db, task.id),
      })),
    );
    const planned = plan
      .flatMap((pair) => [pair.before, pair.after])
      .flatMap((picture) => (picture === null ? [] : [picture]));
    if (planned.length === 0) return;
    const files = await readFiles(planned);
    if (files.length === 0) return;
    const comment = passPostText({
      project: project.name,
      pass: pass.name,
      url,
      pages: tasks.map((task) => ({ title: task.title, link: postLinkOf(task) })),
      more: moreOf(planned.length),
    });

    await uploadToChannel(client, target.channelId, comment, files);

    deps.state.write((w) => {
      setAppSetting(w, postedSetting(project.id), {
        ...marksOf(deps.state.db, project.id),
        [passId]: url,
      });
    });
    const open = findOpenByFoldKey(deps.state.db, project.id, foldKeyOf(passId));
    if (open !== undefined) deps.inbox.withdraw(open.id);
    deps.logger.info({ passId, url }, 'pass pictures posted to Slack');
  }

  function fail(passId: PassId, error: unknown): void {
    const pass = getPass(deps.state.db, passId);
    deps.logger.warn(
      { passId, error: error instanceof Error ? error.message : String(error) },
      'pass pictures not posted to Slack',
    );
    raise(deps.inbox, pass.projectId, {
      tier: CardTier.Ask,
      urgency: Urgency.Low,
      closesWhen: { by: 'withdrawn', when: 'the post lands (slack-picture-post)' },
      title: `The pictures of "${pass.name}" did not reach Slack`,
      body: `The pull request is open and unaffected. Slack's reason: ${reasonOf(error)}. 10db tries again at the pass's next push to the pull request.`,
      foldKey: foldKeyOf(passId),
      refresh: true,
    });
  }

  /** What the post says of the task's run; a read that fails leaves the facts out rather than failing the post. */
  function factsOf(project: ProjectDto, task: TaskDto): TaskPostFacts {
    try {
      return taskPostFacts(deps.state.db, project, task);
    } catch (error) {
      deps.logger.warn(
        { taskId: task.id, error: error instanceof Error ? error.message : String(error) },
        'task facts not read for Slack',
      );
      return noFacts(task);
    }
  }

  /** The id of the task's newest after picture; null when it has none. */
  const newestAfterOf = (taskId: TaskId): string | null =>
    listTaskScreens(deps.state.db, taskId).findLast((s) => s.kind === ScreenKind.After)?.id ?? null;

  /**
   * Posts the task's pictures when its newest after is unmarked; answers that after's id once it is
   * posted, else null. `itemId` is the failure item a retry came from: it is withdrawn whenever the
   * task has nothing to post, even once the task is gone.
   */
  async function postTask(taskId: TaskId, itemId: InboxItemId | null): Promise<string | null> {
    const settle = (project: ProjectDto | null): null => {
      const open =
        project === null
          ? undefined
          : findOpenByFoldKey(deps.state.db, project.id, foldKeyOf(taskId));
      const id = open?.id ?? itemId;
      if (id !== null) deps.inbox.withdraw(id);
      return null;
    };
    let task;
    try {
      task = getTask(deps.state.db, taskId);
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      settle(null);
      return null;
    }
    const project = getProject(deps.state.db, task.projectId);
    if (task.passId != null) return settle(project);
    const target = deps.channelOf(project.id);
    const client = target === null ? null : deps.clientFor(target.teamId);
    if (target === null || client === null) return settle(project);
    // Read once, before the upload: the mark is this after, whatever lands while the files go.
    const newestScreen = listTaskScreens(deps.state.db, taskId).findLast(
      (s) => s.kind === ScreenKind.After,
    );
    const newest = newestScreen?.id ?? null;
    // Only what finished after sharing was turned on goes out; an unreadable or missing time posts nothing.
    const since = target.enabledAt === null ? Number.NaN : Date.parse(target.enabledAt);
    if (newestScreen === undefined) {
      // A finished task whose pictures were skipped says so once, with the reason, and no files.
      const reason = deps.skipped(taskId);
      if (
        reason === null ||
        task.status !== TaskStatus.Done ||
        !(Date.parse(task.updatedAt) >= since) ||
        marksOf(deps.state.db, project.id)[taskId] === SKIPPED_MARK
      )
        return settle(project);
      const text = taskPostText(
        {
          project: project.name,
          title: task.title,
          why: task.why,
          facts: factsOf(project, task),
        },
        { skipped: reason },
      );
      await client.post({
        channel: target.channelId,
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text, verbatim: true } }],
      });
      deps.state.write((w) => {
        setAppSetting(w, postedSetting(project.id), {
          ...marksOf(deps.state.db, project.id),
          [taskId]: SKIPPED_MARK,
        });
      });
      settle(project);
      deps.logger.info({ taskId }, 'task pictures skipped, said in Slack');
      return null;
    }
    if (
      task.status !== TaskStatus.Done ||
      !Number.isFinite(since) ||
      !(Date.parse(newestScreen.createdAt) >= since) ||
      !(Date.parse(task.updatedAt) >= since) ||
      marksOf(deps.state.db, project.id)[taskId] === newest
    )
      return settle(project);
    const planned = picturePlan([
      { title: task.title, screens: listTaskScreens(deps.state.db, taskId) },
    ])
      .flatMap((pair) => [pair.before, pair.after])
      .flatMap((picture) => (picture === null ? [] : [picture]));
    const files = await readFiles(planned);
    if (files.length === 0) return settle(project);
    const comment = taskPostText(
      {
        project: project.name,
        title: task.title,
        why: task.why,
        facts: factsOf(project, task),
      },
      { more: moreOf(planned.length) },
    );

    await uploadToChannel(client, target.channelId, comment, files);

    deps.state.write((w) => {
      setAppSetting(w, postedSetting(project.id), {
        ...marksOf(deps.state.db, project.id),
        [taskId]: newest,
      });
    });
    settle(project);
    deps.logger.info({ taskId, after: newest }, 'task pictures posted to Slack');
    return newest;
  }

  /** What a retry timer writes is a repeat: it raises the item again only when Slack's reason changed. */
  function failTask(taskId: TaskId, error: unknown, repeat: boolean): void {
    const task = getTask(deps.state.db, taskId);
    deps.logger.warn(
      { taskId, error: error instanceof Error ? error.message : String(error) },
      'task pictures not posted to Slack',
    );
    const body = `The task is done and unaffected. Slack's reason: ${reasonOf(error)}. 10db tries again when Settings › Sharing is saved, at start-up, and every 15 minutes while this item is open.`;
    const foldKey = foldKeyOf(taskId);
    const open = findOpenByFoldKey(deps.state.db, task.projectId, foldKey);
    raise(deps.inbox, task.projectId, {
      tier: CardTier.Ask,
      urgency: Urgency.Low,
      closesWhen: { by: 'withdrawn', when: 'the post lands (slack-picture-post)' },
      title: `The pictures of "${task.title}" did not reach Slack`,
      body,
      foldKey,
      ...(repeat && open?.body === body ? {} : { refresh: true }),
    });
  }

  const Attempt = { Posted: 'posted', Nothing: 'nothing', Busy: 'busy', Failed: 'failed' } as const;
  type Attempt = (typeof Attempt)[keyof typeof Attempt];

  async function attemptTask(
    taskId: TaskId,
    itemId: InboxItemId | null,
    repeat: boolean,
  ): Promise<Attempt> {
    if (postingTasks.has(taskId)) return Attempt.Busy;
    postingTasks.add(taskId);
    let marked: string | null = null;
    let outcome: Attempt = Attempt.Nothing;
    try {
      marked = await postTask(taskId, itemId);
      if (marked !== null) outcome = Attempt.Posted;
    } catch (error) {
      outcome = Attempt.Failed;
      try {
        failTask(taskId, error, repeat);
      } catch (inner) {
        deps.logger.warn({ taskId, error: String(inner) }, 'pictures failure not recorded');
      }
    } finally {
      postingTasks.delete(taskId);
    }
    // A second after taken during the upload is announced once more.
    if (marked !== null) {
      try {
        if (newestAfterOf(taskId) !== marked) void attemptTask(taskId, null, false);
      } catch (error) {
        deps.logger.warn({ taskId, error: String(error) }, 'task pictures not rechecked for Slack');
      }
    }
    return outcome;
  }

  /** The retry run under way, if any. */
  let retrying: Promise<void> | null = null;

  async function runRetries(): Promise<void> {
    let items;
    try {
      items = listOpenByFoldKeyPrefix(deps.state.db, `${FOLD_PREFIX}tsk`);
    } catch (error) {
      deps.logger.warn({ error: String(error) }, 'task pictures retries not listed');
      return;
    }
    const stopped = new Set<ProjectId>();
    for (const item of items) {
      if (stopped.has(item.projectId)) continue;
      const taskId = TaskId.safeParse(item.foldKey.slice(FOLD_PREFIX.length));
      if (!taskId.success) continue;
      if ((await attemptTask(taskId.data, item.id, true)) === Attempt.Failed)
        stopped.add(item.projectId);
    }
  }

  return {
    announce(passId, url) {
      if (posting.has(passId)) return;
      // Reading the pass and its marks can throw too; the pull request is open either way, so it never fails.
      try {
        if (marksOf(deps.state.db, getPass(deps.state.db, passId).projectId)[passId] === url)
          return;
      } catch (error) {
        deps.logger.warn({ passId, error: String(error) }, 'pass pictures not checked for Slack');
        return;
      }
      posting.add(passId);
      void post(passId, url)
        .catch((error: unknown) => {
          try {
            fail(passId, error);
          } catch (inner) {
            deps.logger.warn({ passId, error: String(inner) }, 'pictures failure not recorded');
          }
        })
        .finally(() => {
          posting.delete(passId);
        });
    },

    announceTask(taskId) {
      void attemptTask(taskId, null, false);
    },

    retryTasks() {
      // A tick or a save during a run waits for that run.
      retrying ??= runRetries().finally(() => {
        retrying = null;
      });
      return retrying;
    },

    catchUp(sinceMs) {
      void (async () => {
        try {
          // Tasks with an open failure item belong to `retryTasks`.
          const held = new Set(
            listOpenByFoldKeyPrefix(deps.state.db, `${FOLD_PREFIX}tsk`).map((i) => i.foldKey),
          );
          for (const project of listProjects(deps.state.db))
            for (const task of listTasks(deps.state.db, project.id)) {
              const newest = newestAfterOf(task.id);
              if (
                task.status === TaskStatus.Done &&
                task.passId == null &&
                Date.parse(task.updatedAt) >= sinceMs &&
                newest !== null &&
                marksOf(deps.state.db, project.id)[task.id] !== newest &&
                !held.has(foldKeyOf(task.id))
              )
                await attemptTask(task.id, null, false);
            }
        } catch (error) {
          deps.logger.warn({ error: String(error) }, 'task pictures not caught up for Slack');
        }
      })();
    },
  };
}
