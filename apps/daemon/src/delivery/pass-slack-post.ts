import { readFile } from 'node:fs/promises';
import { Urgency, type PassId, type ProjectId } from '@10db/contracts';
import {
  findOpenByFoldKey,
  getAppSetting,
  getPass,
  getProject,
  getTaskScreenRow,
  listTaskScreens,
  setAppSetting,
  type Json,
} from '@10db/db';
import { CardTier } from '../inbox';
import { SlackError, SlackFailure, type SlackClient } from '../slack';
import { raise, type DeliveryContext } from './context';
import { signedOffTasks } from './pass-signed-off';
import { picturePlan } from './pr-pictures';

// Decision 2026-11-23-a-projects-pictures-can-go-to-its-slack-channel: with the project's setting on,
// a pass's pull request is announced once in its channel with the signed-off pages' before and after
// pictures. The post never delays or fails the pull request: it runs detached and, when it fails,
// leaves one Inbox item and tries again at the next push.

/** The most files one message carries; the rest are in the pull request. */
export const MAX_SLACK_PICTURES = 10;

/** Where a project's pictures go, when its setting is on and its workspace is still the one the channel was picked in. */
export interface PictureChannel {
  readonly teamId: string;
  readonly channelId: string;
}

export interface PassSlackPostDeps extends Pick<DeliveryContext, 'state' | 'inbox' | 'logger'> {
  /** The project's channel; null when sharing is off, has no channel, or Slack is not connected for it. */
  readonly channelOf: (projectId: ProjectId) => PictureChannel | null;
  /** The client of a signed-in workspace; null when there is none. */
  readonly clientFor: (teamId: string) => SlackClient | null;
}

export interface PassSlackPost {
  /** Posts the pass's pictures for this pull request unless it was posted or one is in flight. Never throws, never waits. */
  announce(passId: PassId, url: string): void;
}

const postedSetting = (projectId: ProjectId): string => `slack-pictures-posted.${projectId}`;
const foldKeyOf = (passId: PassId): string => `pictures-to-slack:${passId}`;

/** Slack reads these three characters as markup. */
const escapeSlack = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Each pass's pull request that was posted, by pass: a repeat of the same URL posts nothing. */
function marksOf(db: PassSlackPostDeps['state']['db'], projectId: ProjectId): Record<string, Json> {
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

export function createPassSlackPost(deps: PassSlackPostDeps): PassSlackPost {
  /** Passes with a post under way: a sign-off during an upload never posts twice. */
  const posting = new Set<PassId>();

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
    if (files.length === 0) return;
    const more = planned.length - MAX_SLACK_PICTURES;
    const comment = [
      `*${escapeSlack(pass.name)}*: ${String(tasks.length)} ${tasks.length === 1 ? 'page' : 'pages'} signed off, as a pull request.`,
      ...tasks.map((task) => `• ${escapeSlack(task.title)}`),
      ...(more > 0
        ? [
            `${String(more)} more ${more === 1 ? 'picture is' : 'pictures are'} in the pull request.`,
          ]
        : []),
      `<${url}|Open the pull request>`,
    ].join('\n');

    // Joined only when it is a public channel the bot is not in; a private one it is not in can't be.
    const channel = (await client.listChannels()).find((c) => c.id === target.channelId);
    if (channel === undefined)
      throw new SlackError('conversations.list', SlackFailure.ChannelNotFound);
    if (!channel.isMember) {
      if (channel.isPrivate)
        throw new SlackError('conversations.join', SlackFailure.ChannelNotFound);
      await client.joinChannel(channel.id);
    }
    await client.uploadFiles({ channelId: channel.id, comment, files });

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
      closesWhen: { by: 'withdrawn', when: 'the post lands (pass-slack-post)' },
      title: `The pictures of "${pass.name}" did not reach Slack`,
      body: `The pull request is open and unaffected. Slack's reason: ${reasonOf(error)}. 10db tries again at the pass's next push to the pull request.`,
      foldKey: foldKeyOf(passId),
      refresh: true,
    });
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
  };
}
