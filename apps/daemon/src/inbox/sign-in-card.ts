import {
  AreaRole,
  BuilderOwns,
  CARD_OPENS,
  InboxKind,
  ProjectId,
  SAVE_DEV_LOGIN_TOOL,
  SIGN_IN_CANNOT,
  SIGN_IN_OFFER,
  SIGN_IN_SETUP_TASK,
  SignInSetupChoice,
  TaskId,
  TaskStatus,
  Urgency,
  WorkspaceMode,
  type InboxAnswer,
  type InboxItemDto,
  type InboxOption,
  type ProjectDto,
  type TaskInput,
} from '@10db/contracts';
import {
  findOpenByFoldKey,
  getProject,
  getTask,
  insertTask,
  type DbReader,
  type Json,
  type WriteContext,
} from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import { flagCard, type InboxService } from './service';
import { CardTier, decidedByBuilder } from './card-tier';

const RESOLVED = 'The dev login signed the picture browser in';

/** The fold key of a project's card for a failed picture sign-in; one per project. */
export function pictureSignInFoldKey(projectId: ProjectId): string {
  return `picture-sign-in:${projectId}`;
}

/** What a failed sign-in leaves on the card: the words, and what the command printed, masked. */
export interface PictureSignInFailure {
  readonly projectId: ProjectId;
  readonly problem: string;
  readonly exitCode: number | null;
  readonly output: string;
}

interface CardDeps {
  readonly state: StateStore;
  readonly inbox: InboxService;
}

const OPEN_APP_PREVIEW: Record<string, Json> = {
  [CARD_OPENS]: { to: 'settings', section: 'pages-and-pictures', label: 'Open App Preview' },
};

const SIGN_IN_CONTRACT =
  'The dev login command must work by itself every time: create its fictional user if it is missing, run only against the dev database, be safe to repeat, and print one sign-in address.';

/** The task the open card says is setting the project's sign-in up, while that task is still open. */
export function signInSetupTaskOf(db: DbReader, projectId: ProjectId): TaskId | null {
  const card = findOpenByFoldKey(db, projectId, pictureSignInFoldKey(projectId));
  // The detail is the card's own JSON, read back from the database: a boundary, so parse it.
  const named = TaskId.safeParse(card?.detail?.[SIGN_IN_SETUP_TASK]);
  if (!named.success) return null;
  return getTask(db, named.data).status === TaskStatus.Open ? named.data : null;
}

/** The area the setup task names: the catch-all, else the first that is no page, else the first; null with none. */
function setupArea(project: Pick<ProjectDto, 'areas'>): string | null {
  const area =
    project.areas.find((a) => a.catchAll === true) ??
    project.areas.find((a) => a.role !== AreaRole.Page) ??
    project.areas[0];
  return area?.name ?? null;
}

/** What a setup task that found no dev login can work left on the card, and the address and command it held for. */
const CannotWords = z.object({
  found: z.string(),
  decide: z.string(),
  appUrl: z.string().nullable(),
  devLoginCommand: z.string().nullable(),
});
type CannotWords = z.infer<typeof CannotWords>;

/**
 * What the project's open card says a setup task found, while the address and command it was found
 * for still stand: a later failure of the same sign-in keeps the words, and a change by the builder
 * starts afresh.
 */
function standingCannotWords(db: DbReader, project: ProjectDto): CannotWords | null {
  const card = findOpenByFoldKey(db, project.id, pictureSignInFoldKey(project.id));
  // The detail is the card's own JSON, read back from the database: a boundary, so parse it.
  const words = CannotWords.safeParse(card?.detail?.[SIGN_IN_CANNOT]);
  if (!words.success) return null;
  const same =
    words.data.appUrl === project.appUrl && words.data.devLoginCommand === project.devLoginCommand;
  return same ? words.data : null;
}

function cannotLines(words: Pick<CannotWords, 'found' | 'decide'>): string[] {
  return [`What it found: ${words.found}`, `What you need to decide: ${words.decide}`];
}

/** The task Set Up Sign-In makes; null when the project has no area for it to name. */
export function signInSetupTask(project: Pick<ProjectDto, 'name' | 'areas'>): TaskInput | null {
  const area = setupArea(project);
  if (area === null) return null;
  return {
    title: `10db's pictures can sign in to ${project.name}`,
    description: [
      "10db takes pictures of this project's app signed in, and signs its browser in with a dev login: a command, run from this folder, that prints an address which signs a browser in. Write one.",
      "Read the repository's auth, its user model and its seed or fixture code to find how a session is made. The command must create its fictional user (an address on example.test) when it is missing, refuse to run against any database but the local dev one (a non-local database host or a production environment stops it), be safe to run again and again, and print one sign-in URL or path on the app at $TENDB_APP_URL as its last line.",
      'Use what the repository already has where it can. Add a small script or management command to this repository only when one is needed, and commit it as part of this task.',
      "Never use a real person's account, email, password or token, in the command, the repository or your handoff.",
      `Call ${SAVE_DEV_LOGIN_TOOL} with the command: 10db runs it, signs its picture browser in and saves it only if that works, and otherwise tells you what went wrong. Fix it and call again until it is saved. If no command can work as the project stands (the app has no way to make a session without a real person), call ${SAVE_DEV_LOGIN_TOOL} with \`cannot\`, saying what you found and what the builder must decide.`,
    ].join('\n\n'),
    acceptanceCriteria: [
      `${SAVE_DEV_LOGIN_TOOL} saved the dev login command, or was called with cannot saying what was found and what the builder must decide`,
      'The command creates its fictional user when it is missing and touches only the local dev database',
      'The command is safe to repeat and prints one sign-in address on the app',
      "No real person's credentials are in the command, the repository or the handoff",
    ],
    areas: [area],
    workspaceMode: WorkspaceMode.Shared,
  };
}

/** Set Up Sign-In and Not Now, when the project has an area for the setup task to name. */
function offerOptions(project: ProjectDto): Pick<FlagParts, 'options' | 'recommendation'> {
  if (signInSetupTask(project) === null) return {};
  const options: InboxOption[] = [
    {
      label: SignInSetupChoice.SetUp,
      description:
        "Starts a task in this project that reads its sign-in code and writes a dev login; 10db saves it only once it signs the picture browser in. It may add a small script to the project's repository.",
    },
    { label: SignInSetupChoice.NotNow, description: 'Leave it; set the dev login yourself' },
  ];
  return { options, recommendation: SignInSetupChoice.SetUp };
}

interface FlagParts {
  readonly options?: readonly InboxOption[];
  readonly recommendation?: string | null;
}

/**
 * The one card for a project whose picture sign-in failed: no picture of its pages is taken, and
 * none reaches Slack or Linear, until the dev login works. A status card that a check or a sign-in
 * that works closes, so a repeat of the failure only refreshes the card's words. It offers to set the
 * sign-in up, and is left as it is while a task does. What a setup task found when no dev login
 * could work stays on it, until the builder changes the address or the command.
 */
export function raisePictureSignInCard(deps: CardDeps, failure: PictureSignInFailure): void {
  if (signInSetupTaskOf(deps.state.db, failure.projectId) !== null) return;
  const project = getProject(deps.state.db, failure.projectId);
  const printed = failure.output === '' ? [] : ['What it printed (masked):', failure.output];
  const offer = offerOptions(project);
  const cannot = standingCannotWords(deps.state.db, project);
  const setupFound =
    cannot === null
      ? []
      : ['10db tried to set the sign-in up and could not.', ...cannotLines(cannot)];
  deps.inbox.flag({
    projectId: failure.projectId,
    workstreamId: null,
    tier: offer.options === undefined ? CardTier.Status : CardTier.Ask,
    urgency: Urgency.Normal,
    closesWhen: {
      by: 'withdrawn',
      when: "the project's dev login signs the picture browser in (picture-sign-in)",
    },
    decision: decidedByBuilder(BuilderOwns.YourHands),
    title: `${project.name}'s pictures can't sign in`,
    body: [
      failure.problem,
      ...setupFound,
      `No picture of its pages is taken while this lasts, so none reaches Slack or Linear. ${SIGN_IN_CONTRACT}`,
      'Fix the command in Settings › App Preview, or let 10db set it up. 10db checks it again when it changes, when the daemon starts and once a day, and this card closes itself when it signs in.',
      ...printed,
    ].join('\n'),
    detail: {
      ...OPEN_APP_PREVIEW,
      [SIGN_IN_OFFER]: failure.projectId,
      ...(cannot === null ? {} : { [SIGN_IN_CANNOT]: cannot }),
      ...(failure.exitCode === null ? {} : { exitCode: failure.exitCode }),
    },
    ...offer,
    refresh: true,
    foldKey: pictureSignInFoldKey(failure.projectId),
  });
}

/** The card for a project with an app address and no dev login: its signed-in pages can't be pictured, and 10db offers to set one up. */
export function raiseNoSignInOffer(deps: CardDeps, projectId: ProjectId): void {
  if (signInSetupTaskOf(deps.state.db, projectId) !== null) return;
  const project = getProject(deps.state.db, projectId);
  const offer = offerOptions(project);
  deps.inbox.flag({
    projectId,
    workstreamId: null,
    tier: offer.options === undefined ? CardTier.Status : CardTier.Ask,
    urgency: Urgency.Normal,
    closesWhen: {
      by: 'withdrawn',
      when: "the project's dev login signs the picture browser in (picture-sign-in)",
    },
    decision: decidedByBuilder(BuilderOwns.YourHands),
    title: `${project.name}'s pictures have no sign-in`,
    body: [
      'The project has an app address but no dev login, so 10db can picture only the pages anyone can see without signing in.',
      SIGN_IN_CONTRACT,
      'Set one in Settings › App Preview, or let 10db set it up.',
    ].join('\n'),
    detail: { ...OPEN_APP_PREVIEW, [SIGN_IN_OFFER]: projectId },
    ...offer,
    refresh: true,
    foldKey: pictureSignInFoldKey(projectId),
  });
}

const OfferDetail = z.object({ [SIGN_IN_OFFER]: ProjectId });

/**
 * Set Up Sign-In, inside the answer's write: the setup task, and the card that says it is setting the
 * sign-in up, which names it. Answers the task to start once the write commits; null for any other answer.
 */
export function applySignInSetupChoice(
  ctx: WriteContext,
  item: InboxItemDto,
  answer: InboxAnswer,
): TaskId | null {
  if (item.kind !== InboxKind.Flag || answer.choice !== SignInSetupChoice.SetUp) return null;
  // The detail is the item's own JSON, written when it was raised.
  const detail = OfferDetail.safeParse(item.detail);
  if (!detail.success) return null;
  const projectId = detail.data[SIGN_IN_OFFER];
  const project = getProject(ctx.tx, projectId);
  const input = signInSetupTask(project);
  if (input === null) return null;
  const task = insertTask(ctx, projectId, input);
  flagCard(ctx, {
    projectId,
    workstreamId: null,
    tier: CardTier.Status,
    urgency: Urgency.Normal,
    closesWhen: {
      by: 'withdrawn',
      when: "the project's dev login signs the picture browser in (picture-sign-in)",
    },
    decision: decidedByBuilder(BuilderOwns.YourHands),
    title: `10db is setting up ${project.name}'s picture sign-in`,
    body: `The task "${task.title}" is writing a dev login. 10db saves it only once it signs the picture browser in, and this card closes then.`,
    detail: { ...OPEN_APP_PREVIEW, [SIGN_IN_SETUP_TASK]: task.id },
    foldKey: pictureSignInFoldKey(projectId),
  });
  return task.id;
}

/**
 * The setup task found no dev login can work: the one card says what it found and what the builder
 * must decide. `found` and `decide` come masked. The words are kept in the card's detail, so a later
 * failed sign-in that rewrites the card keeps them.
 */
export function cannotSignInCard(
  deps: CardDeps,
  projectId: ProjectId,
  words: { readonly found: string; readonly decide: string },
): void {
  const project = getProject(deps.state.db, projectId);
  deps.inbox.flag({
    projectId,
    workstreamId: null,
    tier: CardTier.Status,
    urgency: Urgency.Normal,
    closesWhen: {
      by: 'withdrawn',
      when: "the project's dev login signs the picture browser in (picture-sign-in)",
    },
    decision: decidedByBuilder(BuilderOwns.YourHands),
    title: `10db can't sign in to ${project.name}'s app for pictures`,
    body: [
      ...cannotLines(words),
      'Until a dev login works, 10db pictures only the pages anyone can see without signing in. Later, 10db will let you sign in once in a window it opens and keep that sign-in until it expires; that is not built yet.',
    ].join('\n'),
    detail: {
      ...OPEN_APP_PREVIEW,
      [SIGN_IN_CANNOT]: {
        found: words.found,
        decide: words.decide,
        appUrl: project.appUrl,
        devLoginCommand: project.devLoginCommand,
      } satisfies CannotWords,
    },
    refresh: true,
    foldKey: pictureSignInFoldKey(projectId),
  });
}

/** Closes the project's picture sign-in card, if one is open. */
export function clearPictureSignInCard(deps: CardDeps, projectId: ProjectId): void {
  const card = findOpenByFoldKey(deps.state.db, projectId, pictureSignInFoldKey(projectId));
  if (card !== undefined) deps.inbox.resolve(card.id, RESOLVED);
}
