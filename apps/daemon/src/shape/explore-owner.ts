import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  ConversationItemKind,
  DeniedBy,
  EventType,
  ShapeId,
  ShapeMessageAuthor,
  ShapeMessageKind,
  shapeFileKind,
  parseItemBody,
  ShapeEventKind,
  TrustSurface,
  JudgeDecision,
  JudgeKind,
  type AccountKind,
  type AgentAccountKind,
  type Effort,
  type ProjectId,
  type ConversationFileId,
} from '@10db/contracts';
import {
  getItem,
  getProject,
  getShape,
  insertShapeMessage,
  listQueuedTurnStarters,
  listRehearsals,
  listShapeFiles,
  listShapeMessages,
  listUntoldShapeFiles,
  markShapeFilesTold,
  markShapeFilesUnreadableTold,
  markShapeLinksSizeTold,
  patchShape,
  type ConversationItemRow,
  type ConversationRow,
  type ShapeFileRow,
  type WriteContext,
} from '@10db/db';
import {
  carriedTooMuch,
  FRESH_START_LINE,
  inlineBytesSpent,
  inlineImageIds,
  inlinePictureBytes,
  pathImageReasons,
  pathReasonText,
  readAllowance,
  readBytesSpent,
  STRICTEST_LIMITS,
  readCountedLine,
  readMeasuredLine,
  readPictureCap,
  unmeasuredRead,
  type ExploreOwnerHooks,
  type PictureLimits,
} from '../conversation';
import { storedModelNames } from '../catalogue';
import type { StateStore } from '../events';
import { stringField } from '../guard';
import { principlesBrief } from '../knowledge';
import type { Logger } from '../log';
import { trustSwitchesFor, warnInvalidTrust } from '../permissions';
import { expandHome } from '../sandbox';
import type { ShapeImage, ShapeToolRequest, ShapeVerdict } from '../sessions';
import {
  buildTrustPolicy,
  judgeForCall,
  projectGrantLines,
  projectLiveSystems,
  startingJudge,
} from '../trust';
import { createHookJudge, createLimitNotes } from '../inbox';
import type { Clock } from '../clock';
import type { Judge } from '../judge';
import { judgeShapeCall, type ShapeAccess } from './confinement';
import { convertedStateNote } from './converted-state';
import { buildDigest } from './digest';
import { asImage, shapeFilesDir } from './dropped-files';
import { shapeAllowedTools, shapeSystemPrompt, shapeToolset } from './policy';
import {
  carriedNotice,
  eachFitsAlone,
  isFileUnchanged,
  isTextOnly,
  measuredMediaBytes,
  noticeName,
  pagesCharged,
  readCeiling,
  readCharge,
  readRefusal,
  refusedImageNotice,
  unreadableImages,
  unreadableImagesNotice,
} from './read-budget';
import type { ShapeLaunch, ShapePrepared, ShapePrepareInput } from './session-launch';
import { untoldMissized, type UntoldMissized } from './sizing';

// Shape spec §5.1–§5.4: Plan as an owner of the explore engine (sessions spec §6.1). The engine runs
// the session's lifecycle; this says what Plan's session is, what each of its turn starters reads as
// (the builder's edits, dropped files and mis-sized tasks ahead of the message), and what Plan checks
// when a turn ends.

/** What a session with nothing prepared answers a call it would have asked about: it has no broker. */
const NOTHING_TO_ASK =
  'This planning session has no sandbox, so it runs no command and asks for nothing.';
/** What the builder reads when a Propose turn's accepted plan has nothing in it. */
const EMPTY_PLAN_NOTICE =
  'The plan came back empty: nothing has been decided yet. Say what you want built, or answer Claude’s questions, then press Propose Again.';
/** What the builder reads past the context limit, as Plan always said it. */
const FRESH_SESSION_WORDS = 'Continued in a fresh session; nothing is lost';

/** What Plan keeps of a conversation between turns, in memory: its notes and the turn's proposals. */
export interface ShapeTurnState {
  /** The builder's edits not yet told to Claude; they go ahead of the next turn. */
  readonly notes: string[];
  /** Whether the turn running now has had an accepted propose_plan call, and how many were refused. */
  proposed: boolean;
  /** Whether the last accepted propose_plan call left the plan empty: no pending or converted row. */
  emptyPlan: boolean;
  refused: number;
}

export interface ShapeOwnerDeps {
  readonly state: StateStore;
  readonly log: Logger;
  readonly mcp: { readonly url: string; readonly toolTimeoutMs: number };
  readonly filesDir: string;
  /**
   * Resolves a project's launch, on `model` or, with null, on the `plan` role's, at `effort` or, with
   * null, the role's.
   */
  launch(projectId: ProjectId, model: string | null, effort: Effort | null): ShapeLaunch;
  readonly prepare?: (input: ShapePrepareInput) => Promise<ShapePrepared>;
  readonly limitsFor: (kind: AccountKind) => PictureLimits;
  /** Who judges a session's calls on an account kind and model (`capabilities.judge`). */
  readonly judgeOf: (kind: AgentAccountKind, model: string) => JudgeKind;
  /** 10db's judge, asked whether it is ready as each session starts; absent, a tendb session is on the rules. */
  readonly judge?: Judge;
  readonly clock: Clock;
  readonly contextLimitPct: number;
  readonly turnOf: (shapeId: ShapeId) => ShapeTurnState;
  /** Tells the screen the conversation changed, for what no row records. */
  readonly announce: (shapeId: ShapeId) => void;
}

/** What goes ahead of a turn's message: the builder's edits since the last turn and the files dropped. */
interface Intake {
  readonly notes: readonly string[];
  readonly files: readonly ShapeFileRow[];
  readonly missized: UntoldMissized;
  readonly converted: string | null;
}

/** The pictures of a turn are held to the account's limits and what the session already carries. */
interface Budget {
  readonly limits: PictureLimits;
  readonly spent: number;
}

/** The images a Read would refuse, and whether Reading any one of them first would be let in. */
interface Unreadable {
  readonly files: readonly ShapeFileRow[];
  readonly readFirst: boolean;
  readonly leftOut: readonly string[];
  readonly limits: PictureLimits;
}

const shapeOf = (conv: ConversationRow): ShapeId => ShapeId.parse(conv.ownerId);

/** The prompt a turn starter carries: a message's text or a press's instruction, under its id. */
function starterText(item: ConversationItemRow): string {
  switch (item.kind) {
    case ConversationItemKind.Message:
      return `[m:${item.id}] ${parseItemBody(item.kind, item.body).text}`;
    case ConversationItemKind.ShapeEvent:
      return `[m:${item.id}] ${parseItemBody(item.kind, item.body).prompt ?? ''}`;
    case ConversationItemKind.AgentMessage:
    case ConversationItemKind.Reasoning:
    case ConversationItemKind.ToolCall:
    case ConversationItemKind.Notice:
    case ConversationItemKind.Digest:
    case ConversationItemKind.Card:
    case ConversationItemKind.Plan:
    case ConversationItemKind.TurnMarker:
      return '';
  }
}

export function createShapeOwner(deps: ShapeOwnerDeps): ExploreOwnerHooks {
  const { state, log } = deps;
  /**
   * The launch a start resolved, kept only for the synchronous run that resolved it. A start asks its
   * questions (resume, limits, the session row's model) and builds its spec with no await between, so
   * one start resolves the project's launch once; anything later, a model pick's question included,
   * resolves it again and sees the project's account as it is then.
   */
  const launches = new Map<
    ShapeId,
    { readonly model: string | null; readonly effort: Effort | null; readonly launch: ShapeLaunch }
  >();
  const launchOf = (shapeId: ShapeId): ShapeLaunch => {
    const shape = getShape(state.db, shapeId);
    const kept = launches.get(shapeId);
    if (kept?.model === shape.model && kept.effort === shape.effort) return kept.launch;
    const launch = deps.launch(shape.projectId, shape.model, shape.effort);
    const entry = { model: shape.model, effort: shape.effort, launch };
    launches.set(shapeId, entry);
    queueMicrotask(() => {
      if (launches.get(shapeId) === entry) launches.delete(shapeId);
    });
    return launch;
  };

  const notice = (ctx: WriteContext, shapeId: ShapeId, body: string): void => {
    insertShapeMessage(ctx, shapeId, {
      author: ShapeMessageAuthor.Note,
      kind: ShapeMessageKind.Notice,
      body,
    });
  };
  const say = (
    shapeId: ShapeId,
    kind: ShapeMessageKind,
    body: string,
    author: ShapeMessageAuthor = ShapeMessageAuthor.Note,
  ) => state.write((ctx) => insertShapeMessage(ctx, shapeId, { author, kind, body }));

  /** The lines that tell Claude what changed since it last heard: edits, mis-sized tasks, files. */
  const intakeText = (
    intake: Intake,
    budget: Budget,
    shown: readonly ShapeFileRow[],
    sizes: readonly string[],
    converted: string | null,
  ): string => {
    const byPath = pathImageReasons(shown, intake.files, budget.spent, budget.limits);
    return [
      ...intake.notes.map((note) => `[note] ${note}`),
      ...(converted === null ? [] : [`[note] ${converted}`]),
      ...(sizes.length === 0 ? [] : [`[note] ${sizes.join('\n')}`]),
      ...shown.map((file) => {
        const reason = byPath.get(file.id);
        return `[file] ${file.storedPath} (${file.name})${reason === undefined ? '' : ` — ${pathReasonText(reason, budget.limits)}; Read it`}`;
      }),
    ].join('\n');
  };

  /** The images a turn points Claude at as a path that a Read would refuse (§5.4). */
  const unreadableOf = (
    shapeId: ShapeId,
    intake: Intake,
    budget: Budget,
    shown: readonly ShapeFileRow[],
    sentInline: ReadonlySet<ConversationFileId>,
    fresh: boolean,
  ): Unreadable => {
    const { limits } = budget;
    const byPath = pathImageReasons(shown, intake.files, fresh ? 0 : budget.spent, limits);
    const leftOut = shown
      .filter((file) => byPath.get(file.id) === 'conversation-full')
      .map(noticeName);
    const paths = shown.filter((file) => byPath.has(file.id));
    if (paths.length === 0) return { files: [], readFirst: false, leftOut, limits };
    const inline =
      (fresh ? 0 : inlinePictureBytes(state, deps.filesDir, shapeId, limits)) +
      intake.files.reduce((sum, file) => sum + (sentInline.has(file.id) ? file.size : 0), 0);
    const messages = fresh ? [] : listShapeMessages(state.db, shapeId);
    const room = readCeiling(inline, limits) - readBytesSpent(messages);
    const cap = readPictureCap(messages);
    const files = unreadableImages(paths, room, cap);
    return { files, readFirst: eachFitsAlone(files, room, cap), leftOut, limits };
  };

  /** The notices for the images `unreadableOf` found, in the write that marks the turn told. */
  const warnUnreadable = (ctx: WriteContext, shapeId: ShapeId, unreadable: Unreadable): void => {
    const { leftOut } = unreadable;
    if (leftOut.length > 0)
      notice(
        ctx,
        shapeId,
        `Left out of this message to keep the conversation within ${unreadable.limits.limitText}: ` +
          `${leftOut.join(', ')}. Claude has ${leftOut.length === 1 ? 'its path' : 'their paths'} and can Read ${leftOut.length === 1 ? 'it' : 'them'}.`,
      );
    if (unreadable.files.length > 0) {
      notice(
        ctx,
        shapeId,
        unreadableImagesNotice(
          unreadable.files.map(noticeName),
          unreadable.readFirst,
          unreadable.limits,
        ),
      );
      markShapeFilesUnreadableTold(
        ctx,
        unreadable.files.map((f) => f.id),
      );
    }
  };

  /** A refused Read of a dropped image, named once (§5.4). */
  const noticeRefusedImage = (
    shapeId: ShapeId,
    readPath: string,
    access: Pick<ShapeAccess, 'checkout' | 'home'>,
    limits: PictureLimits,
  ): void => {
    const target = resolvePath(access.checkout, expandHome(readPath, access.home));
    const file = listShapeFiles(state.db, shapeId).find(
      (f) => resolvePath(f.storedPath) === target,
    );
    if (file?.unreadableToldAt !== null) return;
    state.write((ctx) => {
      notice(ctx, shapeId, refusedImageNotice(noticeName(file), limits));
      markShapeFilesUnreadableTold(ctx, [file.id]);
    });
  };

  /** The dropped images among the files that fit in a message, read from where the daemon keeps them. */
  const imagesOf = (
    files: readonly ShapeFileRow[],
    budget: Budget,
  ): { images: ShapeImage[]; ids: ConversationFileId[] } => {
    const inline = inlineImageIds(files, budget.spent, budget.limits);
    const sent: { images: ShapeImage[]; ids: ConversationFileId[] } = { images: [], ids: [] };
    for (const file of files) {
      if (!inline.has(file.id)) continue;
      try {
        const kind = shapeFileKind(file.name);
        const image = kind === null ? null : asImage(kind, readFileSync(file.storedPath));
        if (image === null) continue;
        sent.images.push(image);
        sent.ids.push(file.id);
      } catch (error) {
        log.warn({ err: error, file: file.name }, 'a dropped image could not be read');
      }
    }
    return sent;
  };

  /** The PreToolUse hook of a session: confinement, then the read budget's charge (§5.4). */
  const preToolUse =
    (shapeId: ShapeId, access: ShapeAccess, limits: PictureLimits) =>
    (req: ShapeToolRequest): ShapeVerdict => {
      let verdict: ShapeVerdict = judgeShapeCall(
        {
          toolName: req.toolName,
          toolInput: req.input,
          agentId: req.agentId,
          agentType: req.agentType,
          cwd: req.cwd,
        },
        access,
      );
      // A picture or PDF the session itself Reads is resent with every later request (§5.4); a
      // subagent's reaches the session as text, so only the session's own Reads are counted.
      const readPath =
        verdict.decision === 'allow' && req.toolName === 'Read' && req.agentId === undefined
          ? stringField(req.input, 'file_path')
          : null;
      if (readPath === null) return verdict;
      const messages = listShapeMessages(state.db, shapeId);
      const allowance = readAllowance(messages);
      const charged = readCharge(
        readPath,
        stringField(req.input, 'pages'),
        access,
        allowance,
        readPictureCap(messages),
      );
      if (charged === null || charged.bytes === 0) return verdict;
      const refusal = readRefusal(
        readPath,
        charged.bytes,
        readBytesSpent(messages),
        readCeiling(inlinePictureBytes(state, deps.filesDir, shapeId, limits), limits),
        charged.kind,
        allowance,
        limits,
      );
      if (refusal !== null) {
        verdict = { decision: 'deny', reason: refusal };
        if (charged.kind === 'picture') noticeRefusedImage(shapeId, readPath, access, limits);
      } else
        say(
          shapeId,
          ShapeMessageKind.Tool,
          readCountedLine(readPath, charged.bytes, charged.kind),
          ShapeMessageAuthor.Claude,
        );
      return verdict;
    };

  return {
    freshAtContextPct: deps.contextLimitPct,
    words: {
      freshSession: FRESH_SESSION_WORDS,
      startFailed: (reason) => `Claude could not start: ${reason}`,
    },
    onParked: (conv) => {
      deps.announce(shapeOf(conv));
    },

    limits(conv) {
      // A launch that can't be resolved is held to the strictest: the start that follows fails anyway.
      try {
        return deps.limitsFor(launchOf(shapeOf(conv)).account.kind);
      } catch {
        return STRICTEST_LIMITS;
      }
    },

    keepsResume(conv) {
      // A resumed session resends every earlier picture to the account that resumes it, which is not
      // always the one that began it (a plan falling back to Bedrock): one that would resend more than
      // this account takes starts fresh from the digest, carrying no earlier picture, and says so.
      const shapeId = shapeOf(conv);
      let launch: ShapeLaunch;
      try {
        launch = launchOf(shapeId);
      } catch {
        return true;
      }
      const limits = deps.limitsFor(launch.account.kind);
      const tooMuch = carriedTooMuch(state, deps.filesDir, shapeId, limits);
      if (tooMuch === null) return true;
      state.write((ctx) => {
        patchShape(ctx, shapeId, { sdkSessionId: null });
        notice(ctx, shapeId, carriedNotice(launch.account.label, tooMuch, limits));
      });
      return false;
    },

    async spec(conv, start) {
      const shapeId = shapeOf(conv);
      const shape = getShape(state.db, shapeId);
      const launch = launchOf(shapeId);
      const limits = deps.limitsFor(launch.account.kind);
      // Only this conversation's files: another conversation's, in the same project or not, stay unread.
      // Where the judge is native the session runs in auto mode, with the web (trust line §8, §12).
      // Plan always asks for its agent's judge; 10db's judge where it is the account's and ready.
      const tendbReady = (await deps.judge?.ready(JudgeDecision.CrossesLimit)) ?? false;
      const judge = startingJudge(
        deps.judgeOf(launch.account.kind, launch.modelId),
        true,
        tendbReady,
      );
      const limitNotes = createLimitNotes();
      const fileAccess: ShapeAccess = {
        ...launch.access,
        filesDir: shapeFilesDir(deps.filesDir, shapeId),
        agentModels: launch.agentModels,
        judge,
      };
      const resumeId = start.resume;
      const { digest } = start;
      const transcript = listShapeMessages(state.db, shapeId);
      const spoken = transcript.some(
        (m) => m.author === ShapeMessageAuthor.Claude && m.kind === ShapeMessageKind.Text,
      );
      const parts: string[] = [];
      // A session with nothing to resume is told the standing rules; a resumed one heard them.
      if (resumeId === null) {
        const brief = principlesBrief(state.db, shape.projectId);
        if (brief !== '') parts.push(brief);
      }
      if (digest !== null) parts.push(digest);
      else if (
        resumeId === null &&
        transcript.some(
          (m) =>
            m.kind === ShapeMessageKind.Screen ||
            (m.kind === ShapeMessageKind.Tool && m.body.startsWith('Read · ')),
        )
      )
        // No digest marks this session's start, so the screens and Reads of the lost one would be
        // charged to this one. This line marks it instead.
        say(shapeId, ShapeMessageKind.Tool, FRESH_START_LINE, ShapeMessageAuthor.Claude);
      // A session that never heard the conversation is told what the builder has said so far: the
      // builder's messages before the first one it is sent, by their place in the transcript.
      if (resumeId === null && !spoken) {
        const first = listQueuedTurnStarters(state.db, conv.id)[0];
        const at = first === undefined ? -1 : transcript.findIndex((m) => m.id === first.id);
        parts.push(
          ...transcript
            .slice(0, at < 0 ? transcript.length : at)
            .filter(
              (m) => m.author === ShapeMessageAuthor.Builder && m.kind === ShapeMessageKind.Text,
            )
            .map((m) => `[m:${m.id}] ${m.body}`),
        );
      }
      parts.push(start.first.text);
      const prompt = parts.join('\n\n');
      // Its sandbox, the project's servers and its broker; a card it waits on is withdrawn when it ends.
      const ending = new AbortController();
      const ready =
        deps.prepare === undefined
          ? null
          : await deps.prepare({
              projectId: shape.projectId,
              conversationId: conv.id,
              shapeId,
              sessionId: start.sessionId,
              accountKind: launch.account.kind,
              env: launch.env,
              resumeProviderSessionId: resumeId,
              signal: ending.signal,
              observer: start.observer,
              limits: limitNotes,
            });
      let released: Promise<void> | null = null;
      const release = (): Promise<void> => {
        released ??= (async () => {
          ending.abort();
          try {
            await ready?.release();
          } catch (error) {
            log.warn({ err: error, shapeId }, 'a shape session’s sandbox could not be removed');
          }
        })();
        return released;
      };
      const commands = ready?.commands;
      // The setup's folders are read as the sandbox opened them, and a `.env*` inside them stays closed.
      const setup = ready?.setup ?? null;
      const withSetup: ShapeAccess =
        setup === null || setup.reads.length === 0
          ? fileAccess
          : {
              ...fileAccess,
              setupReads: setup.reads,
              secretFiles: [...(fileAccess.secretFiles ?? []), ...setup.secretFiles],
            };
      const access: ShapeAccess = commands === undefined ? withSetup : { ...withSetup, commands };
      const toolset = shapeToolset(commands !== undefined);
      const skipped = ready?.note ?? null;
      const project = getProject(state.db, shape.projectId);
      // Read as each session starts, as a lane's is: a live system named meanwhile applies from the next.
      const policy = buildTrustPolicy({
        surface: TrustSurface.Plan,
        projectName: project.name,
        checkout: launch.cwd,
        gateCommand: project.gateCommand,
        liveSystems: projectLiveSystems(state.db, project.id, (stored) => {
          log.warn(
            { stored },
            'the stored live systems are not a list 10db reads, so it reads none',
          );
        }),
        switches: trustSwitchesFor(state.db, project.id, warnInvalidTrust(log)),
        grants: projectGrantLines(state.db, project.id),
      });
      return {
        spec: {
          sessionId: start.sessionId,
          conversationId: conv.id,
          policy,
          profile: {
            kind: 'explore',
            judge,
            systemPrompt: shapeSystemPrompt(launch.agentModels),
            tools: [...toolset.tools],
            allowedTools: [...shapeAllowedTools(judge)],
            disallowedTools: [...toolset.disallowedTools],
            agents: toolset.agents,
          },
          cwd: launch.cwd,
          instructions: ready?.instructions ?? null,
          ...(setup === null
            ? {}
            : { setup: { plugins: setup.pluginDirs, skillRoots: setup.skillRoots } }),
          prompt: skipped === null ? prompt : `${skipped}\n\n${prompt}`,
          ...(start.first.images.length === 0 ? {} : { images: start.first.images }),
          model: launch.model,
          effort: launch.effort,
          resumeProviderSessionId: resumeId,
          env: launch.env,
          account: launch.account,
          mcp: { url: deps.mcp.url, token: start.mcpToken, toolTimeoutMs: deps.mcp.toolTimeoutMs },
          sandbox: ready?.sandbox ?? null,
          projectMcpServers: ready?.projectMcpServers ?? {},
          canUseTool: (req) =>
            ready === null
              ? Promise.resolve({ behavior: 'deny', message: NOTHING_TO_ASK, by: DeniedBy.TenDb })
              : ready.canUseTool(req),
          preToolUse: preToolUse(shapeId, access, limits),
          ...(deps.judge === undefined || judge === JudgeKind.Rules
            ? {}
            : {
                judgeCall: createHookJudge(
                  { judge: deps.judge, state, logger: log },
                  {
                    projectId: project.id,
                    workstreamId: null,
                    taskId: null,
                    // Plan writes nothing, so its edits never reach the fast path's write rule.
                    fastPath: {
                      checkout: launch.cwd,
                      tmpDir: launch.cwd,
                      secretFiles: access.secretFiles ?? [],
                    },
                    policy,
                    preExisting: [],
                    allowLines: () => projectGrantLines(state.db, project.id),
                    judgeNow: (req) => judgeForCall(judge, req.reportedMode ?? null, tendbReady),
                    // Plan's allow list holds none of the project's allowed commands, on native too.
                    coveredByBuilderRule: () => false,
                    floorVerdict: (req) => {
                      const floor = preToolUse(
                        shapeId,
                        { ...access, judge: JudgeKind.Rules },
                        limits,
                      )({ ...req, toolUseId: req.toolUseId ?? undefined });
                      // A rewrite of the call is the guard's; its decision is what the floor gives.
                      return 'updatedInput' in floor ? { decision: 'allow' } : floor;
                    },
                    skips: null,
                    limits: limitNotes,
                    onFloor: () => undefined,
                    clock: deps.clock,
                  },
                ),
              }),
          postToolUse: (req) => {
            // The result of a Read the hook counted replaces the allowance it was charged.
            if (req.toolName !== 'Read' || req.agentId !== undefined) return;
            const path = stringField(req.input, 'file_path');
            if (path === null) return;
            const measured = measuredMediaBytes(req.response);
            const nothingAdded =
              isFileUnchanged(req.response) || (measured === 0 && isTextOnly(req.response));
            if (measured === 0 && !nothingAdded) return;
            const counted = unmeasuredRead(listShapeMessages(state.db, shapeId), path);
            if (counted === null) return;
            const pages = pagesCharged(stringField(req.input, 'pages'));
            say(
              shapeId,
              ShapeMessageKind.Tool,
              readMeasuredLine(
                path,
                measured,
                counted.counted,
                counted.kind,
                Number.isFinite(pages) ? pages : undefined,
              ),
              ShapeMessageAuthor.Claude,
            );
          },
          toolFailed: (req) => {
            // A failed Read returned nothing, so it gives back what it was counted.
            if (req.toolName !== 'Read' || req.agentId !== undefined) return;
            const path = stringField(req.input, 'file_path');
            if (path === null) return;
            const counted = unmeasuredRead(listShapeMessages(state.db, shapeId), path);
            if (counted === null) return;
            say(
              shapeId,
              ShapeMessageKind.Tool,
              readMeasuredLine(path, 0, counted.counted, counted.kind),
              ShapeMessageAuthor.Claude,
            );
          },
        },
        limits,
        expiresAt: ready?.credentialsExpireAt ?? null,
        accountId: launch.account.accountId,
        model: launch.modelId,
        release,
        track: (pid) => {
          ready?.trackProcesses(pid);
        },
      };
    },

    digest: (conv) => buildDigest(state.db, shapeOf(conv)),

    outgoing(conv, item, session) {
      const shapeId = shapeOf(conv);
      const turn = deps.turnOf(shapeId);
      const prompt = starterText(item);
      // What gathered for the next turn goes with the first starter waiting; one pushed again, or a
      // later one of the same push, carries only itself.
      const leads = listQueuedTurnStarters(state.db, conv.id)[0]?.id === item.id;
      if (!leads) return { text: prompt, images: [], blocks: [], sent: () => undefined };
      const intake: Intake = {
        notes: [...turn.notes],
        files: listUntoldShapeFiles(state.db, shapeId),
        missized: untoldMissized(state.db, shapeId),
        converted: convertedStateNote(state.db, shapeId),
      };
      const budget: Budget = {
        limits: session.limits,
        spent: session.fresh ? 0 : inlineBytesSpent(state, deps.filesDir, shapeId, session.limits),
      };
      // A session that never heard the conversation is told about every file; the digest already
      // names every mis-sized task and converted row.
      const shown = session.fresh ? listShapeFiles(state.db, shapeId) : intake.files;
      const digested = session.digest !== null;
      const lines = intakeText(
        intake,
        budget,
        shown,
        digested ? [] : intake.missized.lines,
        digested ? null : intake.converted,
      );
      const { images, ids } = imagesOf(intake.files, budget);
      const unreadable = unreadableOf(shapeId, intake, budget, shown, new Set(ids), session.fresh);
      return {
        text: lines === '' ? prompt : `${lines}\n\n${prompt}`,
        images,
        blocks: ids,
        sent(ctx) {
          // Marked told in the write that marks the starter pushed, so a restart neither loses nor
          // repeats what it carried.
          markShapeFilesTold(
            ctx,
            shown.map((f) => f.id),
          );
          markShapeLinksSizeTold(ctx, intake.missized.linkIds);
          turn.notes.splice(0, intake.notes.length);
          warnUnreadable(ctx, shapeId, unreadable);
          // The screen reads the view again: a turn has begun.
          ctx.emit({
            type: EventType.ShapeChanged,
            entityType: 'shape',
            entityId: shapeId,
            data: { projectId: getShape(ctx.tx, shapeId).projectId },
          });
        },
      };
    },

    onTurnEnded(conv, end) {
      const shapeId = shapeOf(conv);
      const turn = deps.turnOf(shapeId);
      const { proposed, emptyPlan, refused } = turn;
      turn.proposed = false;
      turn.emptyPlan = false;
      turn.refused = 0;
      const presses = end.starters.flatMap((id) => {
        const item = getItem(state.db, id);
        return item.kind === ConversationItemKind.ShapeEvent
          ? [parseItemBody(item.kind, item.body)]
          : [];
      });
      const propose = presses.some((p) => p.kind === ShapeEventKind.Propose);
      const rehearsing = presses.flatMap((p) => p.rehearsing ?? []);
      state.write((ctx) => {
        if (end.how === 'failed')
          notice(ctx, shapeId, "Claude's turn failed; send the message again.");
        if (end.how !== 'complete') return;
        if (propose && !proposed) {
          log.info({ shapeId, refusedProposals: refused }, 'a propose turn proposed nothing');
          notice(ctx, shapeId, "Claude didn't propose; Propose Again");
        } else if (propose && emptyPlan) {
          log.info({ shapeId }, 'a propose turn ended with an empty plan');
          notice(ctx, shapeId, EMPTY_PLAN_NOTICE);
        }
        // A task the turn listed and got no closing report for stays "Not rehearsed".
        if (rehearsing.length > 0) {
          const marked = new Set(
            listRehearsals(ctx.tx, shapeId).map((m) => `${m.taskKey}\0${m.hash}`),
          );
          const skipped = rehearsing.filter((t) => !marked.has(`${t.taskKey}\0${t.hash}`));
          if (skipped.length > 0)
            notice(
              ctx,
              shapeId,
              `The rehearsal didn't read ${String(skipped.length)} of ${String(rehearsing.length)} ${rehearsing.length === 1 ? 'task' : 'tasks'}; ${skipped.length === 1 ? 'it shows' : 'they show'} as Not rehearsed.`,
            );
        }
      });
      deps.announce(shapeId);
      return Promise.resolve();
    },

    describeModel(conv, model) {
      const shapeId = shapeOf(conv);
      const shape = getShape(state.db, shapeId);
      // The conversation's own pick resolves as its next start would; another resolves as itself.
      const launch =
        model === shape.model
          ? launchOf(shapeId)
          : deps.launch(shape.projectId, model, shape.effort);
      // The name the catalogue gives the model, else its ID.
      const name = storedModelNames(state.db).find((m) => m.id === launch.modelId)?.name;
      return {
        model: launch.modelId,
        label: name ?? launch.modelId,
        launchId: launch.model,
        effort: launch.effort,
      };
    },
  };
}
