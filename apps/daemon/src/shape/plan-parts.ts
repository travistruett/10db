import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  ConversationItemKind,
  EventType,
  ShapeMessageAuthor,
  ShapeMessageKind,
  ShapeOrigin,
  parseItemBody,
  Provider,
  ShapeFileKind,
  type ConversationFileId,
  type ShapeId,
} from '@10db/contracts';
import {
  getItem,
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
  pdfTextPath,
  readAllowance,
  readBytesSpent,
  readCountedLine,
  readMeasuredLine,
  readPictureCap,
  unmeasuredRead,
  type ExploreStart,
  type Outgoing,
  type PictureLimits,
  type TurnEnd,
} from '../conversation';
import type { StateStore } from '../events';
import { stringField } from '../guard';
import type { Logger } from '../log';
import { expandHome } from '../sandbox';
import type {
  ShapeAgentDefinition,
  ShapeImage,
  ShapeToolRequest,
  ShapeToolResult,
  ShapeVerdict,
} from '../sessions';
import { PLAN_RESEARCHER, type ShapeAccess } from './confinement';
import { convertedStateNote } from './converted-state';
import { buildDigest } from './digest';
import { asImage } from './dropped-files';
import { shapeSystemPrompt, shapeToolset } from './policy';
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
import { untoldMissized, type UntoldMissized } from './sizing';

// Shape spec §5.1–§5.4 and the sessions-with-a-plan spec §3: what a chat adds when it has a plan. The chat's
// own hooks run the session; this says what the plan adds to it: the prompt and agents, what a turn's message
// is preceded by (the builder's edits, dropped files and mis-sized tasks), the read budget of the pictures the
// session reads, and what is checked when a turn ends.

/** The line a New Plan session starts with, so the agent knows the builder came to plan. */
export const NEW_PLAN_LINE =
  'The builder opened this session to plan. Turn what they bring into goals and tasks as it is decided.';

/** What Plan keeps of a conversation between turns, in memory: the builder's edits not yet told to the agent. */
export interface PlanTurnState {
  readonly notes: string[];
}

export interface PlanPartsDeps {
  readonly state: StateStore;
  readonly log: Logger;
  /** Where each plan's dropped files are kept: `<filesDir>/<shape>`. */
  readonly filesDir: string;
  readonly turnOf: (shapeId: ShapeId) => PlanTurnState;
  /** Tells the screen the plan changed, for what no row records. */
  readonly announce: (shapeId: ShapeId) => void;
  /** Whether a PDF's text is being read, starting the read again if a restart cut it short. */
  readonly pdfTextComing: (storedPath: string, name: string) => boolean;
}

/** What a turn's message is preceded by, and what goes with it. */
export interface PlanIntake {
  readonly lines: string;
  readonly images: Outgoing['images'];
  readonly blocks: readonly ConversationFileId[];
  /** Runs in the write that marks the message's pictures sent. */
  sent(ctx: WriteContext): void;
}

export interface PlanParts {
  /** Appended to the chat's system prompt: Shape's prompt rewritten (no read-only, no Propose). */
  systemPrompt(agentModels: readonly string[], subagents: boolean, web: boolean): string;
  /** 10db's planning agents, named `tendb-*`; {} without subagents; no researcher without the web. */
  agents(
    sandboxed: boolean,
    subagents: boolean,
    web: boolean,
  ): Readonly<Record<string, ShapeAgentDefinition>>;
  /** The plan's folder, made if missing, which the session reads as it reads its chat folder. */
  filesDir(shapeId: ShapeId): string;
  /**
   * The prompt parts a session that never heard the plan starts with: New Plan's line, then the builder's
   * earlier messages it was never sent (the catch-up).
   */
  opening(shapeId: ShapeId, conv: ConversationRow, start: ExploreStart): readonly string[];
  /** The plan's rows as they stand, for a fresh session's digest, after the chat's own. */
  digest(shapeId: ShapeId): string;
  /** The lines that go ahead of a turn's message: edits, notes, mis-sized tasks, untold files. */
  intake(
    shapeId: ShapeId,
    conv: ConversationRow,
    item: ConversationItemRow,
    session: {
      readonly fresh: boolean;
      readonly digest: string | null;
      readonly limits: PictureLimits;
      /** Who runs the session: Codex can't read a PDF, so its intake line points at the PDF's text. */
      readonly provider: Provider;
      /** Picture bytes the turn's own message already sends as blocks, which the one budget counts first. */
      readonly carrying?: number;
    },
  ): PlanIntake;
  /** The read budget's hooks for the session's own Reads (§5.4), after the chat's verdict. */
  reads(
    shapeId: ShapeId,
    access: ShapeAccess,
    limits: PictureLimits,
  ): {
    preToolUse(req: ShapeToolRequest, verdict: ShapeVerdict): ShapeVerdict;
    postToolUse(req: ShapeToolResult): void;
    toolFailed(req: ShapeToolRequest): void;
  };
  /**
   * What the live session already carries toward the account's picture pool: every inline picture of the
   * conversation, the plan's screens, and its Reads beyond their reserve. The one budget a turn's pictures
   * are fitted into, the chat's own message included.
   */
  inlineSpent(shapeId: ShapeId, limits: PictureLimits): number;
  /** False when resuming would resend more pictures than this account takes (carriedTooMuch). */
  keepsResume(shapeId: ShapeId, limits: PictureLimits, accountLabel: string): boolean;
  /** The plan's checks at a turn's end: a turn that failed, a rehearsal that didn't read every task. */
  onTurnEnded(shapeId: ShapeId, end: TurnEnd): void;
  /** Tells the panel the plan changed, for what no row records (a parked start). */
  announce(shapeId: ShapeId): void;
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
  /** Picture bytes the turn's own message sends as blocks, which the plan's pictures are fitted after. */
  readonly carrying: number;
}

/** The images a Read would refuse, and whether Reading any one of them first would be let in. */
interface Unreadable {
  readonly files: readonly ShapeFileRow[];
  readonly readFirst: boolean;
  readonly leftOut: readonly string[];
  readonly limits: PictureLimits;
}

export function createPlanParts(deps: PlanPartsDeps): PlanParts {
  const { state, log } = deps;

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

  /** The lines that tell the agent what changed since it last heard: edits, mis-sized tasks, files. */
  const intakeText = (
    intake: Intake,
    budget: Budget,
    shown: readonly ShapeFileRow[],
    sizes: readonly string[],
    converted: string | null,
    provider: Provider,
  ): string => {
    const byPath = pathImageReasons(shown, intake.files, budget.spent, budget.limits);
    return [
      ...intake.notes.map((note) => `[note] ${note}`),
      ...(converted === null ? [] : [`[note] ${converted}`]),
      ...(sizes.length === 0 ? [] : [`[note] ${sizes.join('\n')}`]),
      ...shown.map((file) => {
        if (file.mediaType === ShapeFileKind.Pdf) return pdfLine(file, provider);
        const reason = byPath.get(file.id);
        return `[file] ${file.storedPath} (${file.name})${reason === undefined ? '' : ` — ${pathReasonText(reason, budget.limits)}; Read it`}`;
      }),
    ].join('\n');
  };

  /**
   * A PDF's line. Claude reads the PDF itself, scans included. Codex can't read a PDF, so it gets the
   * PDF's text, or a note when 10db found none (a scan).
   */
  const pdfLine = (file: ShapeFileRow, provider: Provider): string => {
    if (provider !== Provider.Codex) return `[file] ${file.storedPath} (${file.name})`;
    const textPath = pdfTextPath(file.storedPath);
    if (existsSync(textPath))
      return `[file] ${textPath} (${file.name}: the PDF's text; Codex can't read a PDF)`;
    if (deps.pdfTextComing(file.storedPath, file.name))
      return `[file] ${file.storedPath} (${file.name}: 10db is still reading the PDF's text; it will be at ${textPath})`;
    return `[file] ${file.storedPath} (${file.name}: a PDF with no text 10db could read, and Codex can't read a PDF)`;
  };

  /** The images a turn points the agent at as a path that a Read would refuse (§5.4). */
  const unreadableOf = (
    shapeId: ShapeId,
    intake: Intake,
    budget: Budget,
    shown: readonly ShapeFileRow[],
    sentInline: ReadonlySet<ConversationFileId>,
    fresh: boolean,
  ): Unreadable => {
    const { limits } = budget;
    const byPath = pathImageReasons(shown, intake.files, budget.spent, limits);
    const leftOut = shown
      .filter((file) => byPath.get(file.id) === 'conversation-full')
      .map(noticeName);
    const paths = shown.filter((file) => byPath.has(file.id));
    if (paths.length === 0) return { files: [], readFirst: false, leftOut, limits };
    const inline =
      (fresh ? 0 : inlinePictureBytes(state, deps.filesDir, shapeId, limits)) +
      budget.carrying +
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
          `${leftOut.join(', ')}. The agent has ${leftOut.length === 1 ? 'its path' : 'their paths'} and can Read ${leftOut.length === 1 ? 'it' : 'them'}.`,
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
        const image = asImage(file.mediaType, readFileSync(file.storedPath));
        if (image === null) continue;
        sent.images.push(image);
        sent.ids.push(file.id);
      } catch (error) {
        log.warn({ err: error, file: file.name }, 'a dropped image could not be read');
      }
    }
    return sent;
  };

  /** The read budget's charge for a Read the chat's judge let through (§5.4). */
  const charge = (
    shapeId: ShapeId,
    access: ShapeAccess,
    limits: PictureLimits,
    req: ShapeToolRequest,
    allowed: ShapeVerdict,
  ): ShapeVerdict => {
    // A picture or PDF the session itself Reads is resent with every later request (§5.4); a
    // subagent's reaches the session as text, so only the session's own Reads are counted.
    const readPath =
      allowed.decision === 'allow' && req.toolName === 'Read' && req.agentId === undefined
        ? stringField(req.input, 'file_path')
        : null;
    if (readPath === null) return allowed;
    const messages = listShapeMessages(state.db, shapeId);
    const allowance = readAllowance(messages);
    const charged = readCharge(
      readPath,
      stringField(req.input, 'pages'),
      access,
      allowance,
      readPictureCap(messages),
    );
    if (charged === null || charged.bytes === 0) return allowed;
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
      if (charged.kind === 'picture') noticeRefusedImage(shapeId, readPath, access, limits);
      return { decision: 'deny', reason: refusal };
    }
    say(
      shapeId,
      ShapeMessageKind.Tool,
      readCountedLine(readPath, charged.bytes, charged.kind),
      ShapeMessageAuthor.Claude,
    );
    return allowed;
  };

  return {
    systemPrompt: shapeSystemPrompt,

    agents(sandboxed, subagents, web) {
      if (!subagents) return {};
      const { agents } = shapeToolset(sandboxed);
      // The researcher is the only agent that reaches the web: without the web it has nothing to do.
      return web
        ? agents
        : Object.fromEntries(Object.entries(agents).filter(([name]) => name !== PLAN_RESEARCHER));
    },

    filesDir(shapeId) {
      const dir = join(deps.filesDir, shapeId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },

    opening(shapeId, conv, start) {
      const shape = getShape(state.db, shapeId);
      const transcript = listShapeMessages(state.db, shapeId);
      const spoken = transcript.some(
        (m) => m.author === ShapeMessageAuthor.Claude && m.kind === ShapeMessageKind.Text,
      );
      const parts: string[] = [];
      if (shape.origin === ShapeOrigin.App && !spoken) parts.push(NEW_PLAN_LINE);
      if (
        start.digest === null &&
        start.resume === null &&
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
      if (start.resume === null && !spoken) {
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
      return parts;
    },

    digest: (shapeId) => buildDigest(state.db, shapeId),

    intake(shapeId, conv, item, session) {
      const none: PlanIntake = { lines: '', images: [], blocks: [], sent: () => undefined };
      // What gathered for the next turn goes with the first starter waiting; one pushed again, or a
      // later one of the same push, carries only itself.
      if (listQueuedTurnStarters(state.db, conv.id)[0]?.id !== item.id) return none;
      const turn = deps.turnOf(shapeId);
      const intake: Intake = {
        notes: [...turn.notes],
        files: listUntoldShapeFiles(state.db, shapeId),
        missized: untoldMissized(state.db, shapeId),
        converted: convertedStateNote(state.db, shapeId),
      };
      const budget: Budget = {
        limits: session.limits,
        spent:
          (session.fresh ? 0 : inlineBytesSpent(state, deps.filesDir, shapeId, session.limits)) +
          (session.carrying ?? 0),
        carrying: session.carrying ?? 0,
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
        session.provider,
      );
      const { images, ids } = imagesOf(intake.files, budget);
      const unreadable = unreadableOf(shapeId, intake, budget, shown, new Set(ids), session.fresh);
      return {
        lines,
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

    reads(shapeId, access, limits) {
      return {
        preToolUse: (req, verdict) => charge(shapeId, access, limits, req, verdict),
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
      };
    },

    inlineSpent: (shapeId, limits) => inlineBytesSpent(state, deps.filesDir, shapeId, limits),

    keepsResume(shapeId, limits, accountLabel) {
      // A resumed session resends every earlier picture to the account that resumes it, which is not
      // always the one that began it (a plan falling back to Bedrock): one that would resend more than
      // this account takes starts fresh from the digest, carrying no earlier picture, and says so.
      const tooMuch = carriedTooMuch(state, deps.filesDir, shapeId, limits);
      if (tooMuch === null) return true;
      state.write((ctx) => {
        patchShape(ctx, shapeId, { sdkSessionId: null });
        notice(ctx, shapeId, carriedNotice(accountLabel, tooMuch, limits));
      });
      return false;
    },

    onTurnEnded(shapeId, end) {
      const rehearsing = end.starters.flatMap((id) => {
        const item = getItem(state.db, id);
        return item.kind === ConversationItemKind.ShapeEvent
          ? (parseItemBody(item.kind, item.body).rehearsing ?? [])
          : [];
      });
      state.write((ctx) => {
        if (end.how === 'failed') notice(ctx, shapeId, 'The turn failed; send the message again.');
        if (end.how !== 'complete') return;
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
    },

    announce: (shapeId) => {
      deps.announce(shapeId);
    },
  };
}
