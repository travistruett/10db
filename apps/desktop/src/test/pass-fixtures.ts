import type { TurnActivityDto } from '@10db/contracts';
import {
  ConversationId,
  ConversationItemDto,
  ConversationItemsPage,
  ConversationLiveDto,
  GoalPassPagesDto,
  mintId,
  pageLabel,
  PassDto,
  PassNotice,
  PassOpenedDto,
  PASS_SIGN_OFF_CHOICE,
  PassPageDto,
  PassStartDto,
  PassTurnTimingDto,
  PassTurnWithFilesDto,
  TaskScreenDto,
  PassViewDto,
  TaskMessageDto,
  WorkbenchSetupDto,
  type InboxItemDto,
  type PassTurnActivity,
  type TaskId,
  type WorkstreamId,
} from '@10db/contracts';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { daemonUrl } from './daemon';
import { batchDto, inboxItemDto } from './fixtures';

// Workbench fixtures. Every DTO is parsed with its contract, so a contract change breaks the fixture
// before it breaks a view, and the handlers answer the routes the daemon serves for the Workbench.

/** When the pass opened; every page's times count from here. */
export const PASS_OPENED_AT = '2026-11-09T12:00:00.000Z';
/** The clock the fixtures are read at: half an hour into the pass. */
export const PASS_NOW = '2026-11-09T12:30:00.000Z';

/** `minutes` before `PASS_NOW`, as an ISO time. */
export function minutesBeforeNow(minutes: number): string {
  return new Date(Date.parse(PASS_NOW) - minutes * 60_000).toISOString();
}

export function passDto(overrides: Partial<PassDto> = {}): PassDto {
  return PassDto.parse({
    id: mintId('Pass'),
    projectId: mintId('Project'),
    name: 'Settings pass',
    state: 'OPEN',
    batchId: mintId('Batch'),
    pageCap: 4,
    returnBranch: 'main',
    startSha: 'a'.repeat(40),
    openedAt: PASS_OPENED_AT,
    createdAt: PASS_OPENED_AT,
    updatedAt: PASS_OPENED_AT,
    ...overrides,
  });
}

/** What `POST /projects/:projectId/passes` answers: the pass opened on a clean folder. */
export function passOpenedDto(pass: Partial<PassDto> = {}): PassOpenedDto {
  const opened = passDto(pass);
  return PassOpenedDto.parse({
    pass: opened,
    batch: batchDto({ id: opened.batchId, projectId: opened.projectId, passId: opened.id }),
    dirt: [],
    aheadOfBase: 0,
    waiting: [],
  });
}

/** A page's latest turn, started `startedMinutesAgo` before `PASS_NOW`. */
export function pageTurn(
  overrides: Partial<NonNullable<PassPageDto['turn']>> & { startedMinutesAgo?: number } = {},
): NonNullable<PassPageDto['turn']> {
  const { startedMinutesAgo = 4, ...rest } = overrides;
  return {
    id: mintId('PassTurn'),
    seq: 1,
    startedAt: minutesBeforeNow(startedMinutesAgo),
    endedAt: null,
    readyAt: null,
    activity: null,
    ...rest,
  };
}

/** A page that has not been spoken to: no run has started a turn. */
export function passPageDto(overrides: Partial<PassPageDto> = {}): PassPageDto {
  return PassPageDto.parse({
    taskId: mintId('Task'),
    title: 'Settings: UI work',
    area: 'Settings',
    label: pageLabel({ name: overrides.area ?? 'Settings' }),
    route: '/settings',
    workstreamId: mintId('Workstream'),
    state: 'QUEUED',
    nextActionKind: 'start',
    spokenTo: false,
    conversationId: mintId('Conversation'),
    turn: null,
    pausedUntil: null,
    failure: null,
    signOff: 'none',
    waitsFor: null,
    preview: null,
    ...overrides,
  });
}

/** What a working turn reports: the agent editing the page's file. */
export function turnActivity(overrides: Partial<PassTurnActivity> = {}): PassTurnActivity {
  return {
    tool: 'Edit',
    target: 'src/settings/page.tsx',
    filesTouched: ['src/settings/page.tsx'],
    at: minutesBeforeNow(1),
    ...overrides,
  };
}

/**
 * One page in each state the queue draws, at `PASS_NOW`. `asks` waits on `askItem(asks)`, a question
 * that targets its run; the others need no Inbox item.
 */
export function pagesByStatus() {
  const notStarted = passPageDto({
    title: 'Home: UI work',
    area: 'Home',
    label: 'Home',
    route: '/',
  });
  const working = passPageDto({
    title: 'Billing: UI work',
    area: 'Billing',
    label: 'Billing',
    route: '/billing',
    state: 'RUNNING',
    spokenTo: true,
    turn: pageTurn({ startedMinutesAgo: 4, activity: turnActivity() }),
  });
  const ready = passPageDto({
    title: 'Settings: UI work',
    area: 'Settings',
    label: 'Settings',
    route: '/settings',
    state: 'WAITING_HUMAN',
    nextActionKind: 'pass_review',
    spokenTo: true,
    turn: pageTurn({
      startedMinutesAgo: 12,
      endedAt: minutesBeforeNow(3),
      readyAt: minutesBeforeNow(3),
    }),
  });
  const asks = passPageDto({
    title: 'People: UI work',
    area: 'People',
    label: 'People',
    route: '/people',
    state: 'WAITING_HUMAN',
    nextActionKind: 'answer',
    spokenTo: true,
    turn: pageTurn({ startedMinutesAgo: 6 }),
  });
  const failed = passPageDto({
    title: 'Reports: UI work',
    area: 'Reports',
    label: 'Reports',
    route: '/reports',
    state: 'WAITING_HUMAN',
    nextActionKind: 'pass_review',
    spokenTo: true,
    turn: pageTurn({ startedMinutesAgo: 9, endedAt: minutesBeforeNow(8) }),
    failure: { failureKind: 'session_failed', retryItemId: mintId('InboxItem') },
  });
  const paused = passPageDto({
    title: 'Team: UI work',
    area: 'Team',
    label: 'Team',
    route: '/team',
    state: 'PAUSED_LIMIT',
    nextActionKind: 'resume',
    spokenTo: true,
    turn: pageTurn({ startedMinutesAgo: 15 }),
    pausedUntil: '2026-11-09T15:40:00.000Z',
  });
  return { notStarted, working, ready, asks, failed, paused };
}

/** The `check` item of a page of `view` that became Ready, as the Inbox holds it. */
export function readyItem(view: PassViewDto, page: PassPageDto): InboxItemDto {
  return inboxItemDto({
    projectId: view.pass.projectId,
    kind: 'check',
    title: `Ready: ${page.title}`,
    body: '',
    options: [{ label: PASS_SIGN_OFF_CHOICE, description: '' }],
    detail: {
      passId: view.pass.id,
      taskId: page.taskId,
      workstreamId: page.workstreamId ?? mintId('Workstream'),
      turnId: page.turn?.id ?? mintId('PassTurn'),
      keptSha: 'b'.repeat(40),
      keptBaseSha: 'a'.repeat(40),
      turnFiles: [],
      pageFiles: [],
    },
  });
}

/** A notice in the pass's header: failing checks, sendable, unless given. */
export function passNotice(overrides: Partial<PassNotice> = {}): PassNotice {
  return PassNotice.parse({
    id: 'checks',
    kind: 'checks',
    text: "The pull request's checks fail: test (ubuntu-24.04).",
    sendable: true,
    cardId: null,
    at: minutesBeforeNow(2),
    ...overrides,
  });
}

/** An open card of `view`'s pass, as the Inbox holds it, with `detail` (one of `PassCardDetail`). */
export function passCard(
  view: PassViewDto,
  detail: NonNullable<InboxItemDto['detail']>,
  overrides: Partial<InboxItemDto> = {},
): InboxItemDto {
  return inboxItemDto({
    projectId: view.pass.projectId,
    kind: 'flag',
    title: 'UI Workbench',
    body: '',
    options: [],
    detail,
    ...overrides,
  });
}

/** An open question from the page's run, as the Inbox holds it. */
export function askItem(page: PassPageDto, overrides: Partial<InboxItemDto> = {}): InboxItemDto {
  return inboxItemDto({
    title: `${page.title} asks`,
    targets: page.workstreamId ? [{ workstreamId: page.workstreamId, sessionId: null }] : [],
    ...overrides,
  });
}

export function passTurnTimingDto(overrides: Partial<PassTurnTimingDto> = {}): PassTurnTimingDto {
  return PassTurnTimingDto.parse({
    taskId: mintId('Task'),
    seq: 1,
    startedAt: minutesBeforeNow(20),
    endedAt: null,
    readyAt: null,
    openedAt: null,
    answeredAt: null,
    ...overrides,
  });
}

/** A pass with `pages`; its timings are one per page that has a turn, unless given. */
export function passViewDto(
  overrides: {
    pass?: Partial<PassDto>;
    pages?: PassPageDto[];
    turns?: PassTurnTimingDto[];
    /** The view's other fields: its notices, pull request, close step. */
    rest?: Partial<Omit<PassViewDto, 'pass' | 'pages' | 'turns'>>;
  } = {},
): PassViewDto {
  const pages = overrides.pages ?? Object.values(pagesByStatus());
  const turns =
    overrides.turns ??
    pages.flatMap((page) =>
      page.turn
        ? [
            passTurnTimingDto({
              taskId: page.taskId,
              seq: page.turn.seq,
              startedAt: page.turn.startedAt,
              endedAt: page.turn.endedAt,
              readyAt: page.turn.readyAt,
            }),
          ]
        : [],
    );
  return PassViewDto.parse({
    pass: passDto(overrides.pass),
    pages,
    preview: null,
    turns,
    holds: [],
    sharedChanges: [],
    signOffWaits: [],
    pullRequest: null,
    checks: { gate: { state: 'not_run', logPath: null }, review: { reviewedSha: null } },
    closeStep: null,
    stackedOn: null,
    notices: [],
    ...overrides.rest,
  });
}

export function passStartDto(overrides: Partial<PassStartDto> = {}): PassStartDto {
  return PassStartDto.parse({
    pages: [
      {
        area: 'Settings',
        label: 'Settings',
        route: '/settings',
        lastChangedAt: minutesBeforeNow(60 * 24),
        uncommitted: 3,
        heldBy: null,
      },
      {
        area: 'People',
        label: 'People',
        route: '/people',
        lastChangedAt: minutesBeforeNow(60),
        uncommitted: 0,
        heldBy: null,
      },
      {
        area: 'Billing',
        label: 'Billing',
        route: null,
        lastChangedAt: null,
        uncommitted: 0,
        heldBy: null,
      },
    ],
    otherUncommitted: 12,
    lacks: [],
    refusal: null,
    ...overrides,
  });
}

/** The setup for a project with one area, `src`: a Settings page and a shared `src`, unless overridden. */
export function workbenchSetupDto(overrides: Partial<WorkbenchSetupDto> = {}): WorkbenchSetupDto {
  return WorkbenchSetupDto.parse({
    areas: {
      proposed: [
        { name: 'settings', globs: ['src/settings/**'], role: 'page', route: '/settings' },
        { name: 'src', globs: ['src/**'], role: 'shared' },
      ],
      kept: [],
      pages: [{ name: 'settings', route: '/settings', folders: ['src/settings/'] }],
      skipped: [],
    },
    settings: [],
    branch: null,
    ...overrides,
  });
}

export function goalPassPagesDto(overrides: Partial<GoalPassPagesDto> = {}): GoalPassPagesDto {
  return GoalPassPagesDto.parse({
    pages: ['Settings'],
    fromTasks: [mintId('Task')],
    ...overrides,
  });
}

export function passTurnWithFilesDto(
  overrides: Partial<PassTurnWithFilesDto> = {},
): PassTurnWithFilesDto {
  return PassTurnWithFilesDto.parse({
    id: mintId('PassTurn'),
    taskId: mintId('Task'),
    workstreamId: mintId('Workstream'),
    sessionId: null,
    seq: 1,
    messageId: null,
    startedAt: minutesBeforeNow(12),
    endedAt: minutesBeforeNow(3),
    ending: 'ready',
    settledAt: minutesBeforeNow(3),
    keptSha: 'b'.repeat(40),
    keptBaseSha: 'a'.repeat(40),
    sharedSeq: null,
    check: 'none',
    readyAt: minutesBeforeNow(3),
    openedAt: null,
    answeredAt: null,
    files: [{ path: 'src/settings/page.tsx', added: 4, removed: 1 }],
    ...overrides,
  });
}

/** The data of a `session.activity` event from a pass lane's turn. */
export function passActivityData(
  workstreamId: WorkstreamId,
  turnId: NonNullable<PassPageDto['turn']>['id'],
  overrides: {
    tool?: { name: string; target: string | null } | null;
    filesTouched?: string[];
  } = {},
) {
  return {
    workstreamId,
    kind: 'tool_use',
    summary: 'Edit src/settings/form.tsx',
    tool:
      overrides.tool === undefined
        ? { name: 'Edit', target: 'src/settings/form.tsx' }
        : overrides.tool,
    turn: {
      id: turnId,
      filesTouched: overrides.filesTouched ?? ['src/settings/page.tsx', 'src/settings/form.tsx'],
    },
  };
}

/** A message in `taskId`'s thread: the builder's, unless given. */
export function taskMessageDto(
  taskId: TaskId,
  overrides: Partial<TaskMessageDto> = {},
): TaskMessageDto {
  return TaskMessageDto.parse({
    id: mintId('ConversationItem'),
    taskId,
    author: 'builder',
    kind: 'message',
    body: 'The padding is too tight',
    createdAt: minutesBeforeNow(12),
    pushedAt: minutesBeforeNow(12),
    deliveredAt: minutesBeforeNow(12),
    files: [],
    sendable: false,
    allowThis: false,
    ...overrides,
  });
}

/** An item of a page's conversation: the builder's message, unless given. */
export function pageItemDto(
  conversationId: ConversationId,
  item: Partial<ConversationItemDto> & Pick<ConversationItemDto, 'kind'>,
): ConversationItemDto {
  return ConversationItemDto.parse({
    id: mintId('ConversationItem'),
    conversationId,
    seq: 1,
    author: 'builder',
    partial: false,
    hasFull: false,
    deliveredAt: null,
    createdAt: minutesBeforeNow(12),
    text: 'The padding is too tight',
    ...item,
  });
}

/** What the Workbench's routes answer; each left out answers as a project with no pass would. */
export interface PassRoutes {
  /** `GET /passes?live=true`. */
  readonly live?: readonly PassViewDto[];
  /** By project id. */
  readonly start?: Readonly<Record<string, PassStartDto>>;
  /** By task id. */
  readonly turns?: Readonly<Record<string, readonly PassTurnWithFilesDto[]>>;
  /** By turn id. */
  readonly activity?: Readonly<Record<string, readonly TurnActivityDto[]>>;
  /** A task conversation's items, by conversation id. */
  readonly conversations?: Readonly<Record<string, readonly ConversationItemDto[]>>;
  /** What a task conversation streams now, by conversation id. */
  readonly streams?: Readonly<Record<string, ConversationLiveDto['items']>>;
  readonly goalPages?: GoalPassPagesDto;
  readonly setup?: WorkbenchSetupDto;
}

/** MSW handlers for the Workbench's reads. Put them before `baseHandlers()` in `server.use`. */
export function passHandlers(routes: PassRoutes = {}): HttpHandler[] {
  const live = routes.live ?? [];
  return [
    http.get(daemonUrl('/passes'), () => HttpResponse.json(live)),
    http.get(daemonUrl('/passes/:passId'), ({ params }) => {
      const view = live.find((v) => v.pass.id === params['passId']);
      return view
        ? HttpResponse.json(view)
        : HttpResponse.json({ error: 'not_found', message: 'No such pass' }, { status: 404 });
    }),
    http.get(daemonUrl('/projects/:projectId/pass-start'), ({ params }) =>
      HttpResponse.json(
        routes.start?.[String(params['projectId'])] ??
          passStartDto({ pages: [], otherUncommitted: 0 }),
      ),
    ),
    http.get(daemonUrl('/tasks/:taskId/turns'), ({ params }) =>
      HttpResponse.json(routes.turns?.[String(params['taskId'])] ?? []),
    ),
    // Showing a Ready page marks its turn opened.
    http.post(
      daemonUrl('/tasks/:taskId/turns/:turnId/opened'),
      () => new HttpResponse(null, { status: 204 }),
    ),
    http.get(daemonUrl('/pass-turns/:turnId/activity'), ({ params }) =>
      HttpResponse.json(routes.activity?.[String(params['turnId'])] ?? []),
    ),
    http.get(daemonUrl('/conversations/:conversationId/items'), ({ params }) =>
      HttpResponse.json(
        ConversationItemsPage.parse({
          items: routes.conversations?.[String(params['conversationId'])] ?? [],
          nextAfterSeq: null,
        }),
      ),
    ),
    http.get(daemonUrl('/conversations/:conversationId/live'), ({ params }) => {
      const conversationId = ConversationId.parse(params['conversationId']);
      return HttpResponse.json(
        ConversationLiveDto.parse({
          conversationId,
          items: routes.streams?.[conversationId] ?? [],
          waitingForFolder: false,
        }),
      );
    }),
    http.get(daemonUrl('/goals/:goalId/pass-pages'), () =>
      HttpResponse.json(routes.goalPages ?? goalPassPagesDto({ pages: [], fromTasks: [] })),
    ),
    http.post(daemonUrl('/projects/:projectId/workbench-setup'), () =>
      HttpResponse.json(routes.setup ?? workbenchSetupDto()),
    ),
  ];
}

/** A picture of a task's page: a before of `/settings`, 1440 by 900, unless overridden. */
export function taskScreenDto(overrides: Partial<TaskScreenDto> = {}): TaskScreenDto {
  return TaskScreenDto.parse({
    id: mintId('TaskScreen'),
    taskId: mintId('Task'),
    turnId: null,
    turnSeq: null,
    kind: 'before',
    route: '/settings',
    viewport: { width: 1440, height: 900 },
    theme: 'default',
    width: 1440,
    height: 900,
    size: 1234,
    sha256: 'a'.repeat(64),
    keptSha: null,
    createdAt: minutesBeforeNow(20),
    ...overrides,
  });
}
