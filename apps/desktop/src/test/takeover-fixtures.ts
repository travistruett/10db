import {
  TakeoverCommandDto,
  TakeoverDto,
  TakeoverPreviewDto,
  type ChatId,
  type TerminalApp,
} from '@10db/contracts';
import { http, HttpResponse, type HttpHandler } from 'msw';
import { chatDto, type ChatServer } from './chat-fixtures';
import { daemonUrl } from './daemon';

// The routes of Open in Terminal and Hand Back over the chats a `chatServer` holds: opening moves the chat to
// `taken_over`, handing back moves it to `idle_cold`, as the daemon does. Every body is parsed with its contract.

const SINCE = '2026-11-16T12:04:00.000Z';

export interface TakeoverServerOptions {
  /** What the preview answers. */
  readonly preview?: TakeoverPreviewDto;
  /** The app Settings › Sessions names. */
  readonly app?: TerminalApp;
  /** The command Copy the Command gives. */
  readonly line?: string;
  /** The notes the open leaves for the banner, beside the folder note. */
  readonly openNotes?: readonly string[];
  /** Opening answers 502 with these words. */
  readonly openFails?: string;
}

export interface TakeoverServer {
  readonly handlers: HttpHandler[];
  readonly opened: ChatId[];
  readonly handedBack: ChatId[];
  readonly commands: ChatId[];
  /** Each change Settings › Sessions sent. */
  readonly settingsPatches: unknown[];
}

export function takeoverServer(
  chats: ChatServer,
  opts: TakeoverServerOptions = {},
): TakeoverServer {
  const app = opts.app ?? 'terminal';
  const line = opts.line ?? "/bin/sh -c 'exec ~/.10db/takeover/run'";
  const notes = ['Your folder is held until you hand back.'];
  // What the daemon keeps of the open, for the banner's read.
  let taken: string[] = notes;
  const server: TakeoverServer = {
    handlers: [],
    opened: [],
    handedBack: [],
    commands: [],
    settingsPatches: [],
  };
  const byConversation = (id: string) => chats.chats.find((c) => c.conversationId === id);
  const move = (id: string, state: 'taken_over' | 'idle_cold'): ChatId | null => {
    const chat = byConversation(id);
    if (chat === undefined) return null;
    chats.chats.splice(
      chats.chats.indexOf(chat),
      1,
      chatDto({ ...chat, conversation: { ...chat.conversation, state } }),
    );
    return chat.id;
  };
  server.handlers.push(
    http.get(daemonUrl('/conversations/:conversationId/takeover/preview'), () =>
      HttpResponse.json(TakeoverPreviewDto.parse(opts.preview ?? { refusal: null, notes })),
    ),
    http.post(daemonUrl('/conversations/:conversationId/takeover'), ({ params }) => {
      if (opts.openFails !== undefined)
        return HttpResponse.json({ error: 'upstream', message: opts.openFails }, { status: 502 });
      const id = move(String(params['conversationId']), 'taken_over');
      if (id !== null) server.opened.push(id);
      taken = [...notes, ...(opts.openNotes ?? [])];
      return HttpResponse.json(
        TakeoverDto.parse({ since: SINCE, app, notes: taken, line: app === 'copy' ? line : null }),
      );
    }),
    http.get(daemonUrl('/conversations/:conversationId/takeover'), () =>
      HttpResponse.json(TakeoverDto.parse({ since: SINCE, app, notes: taken, line: null })),
    ),
    http.post(daemonUrl('/conversations/:conversationId/takeover/command'), ({ params }) => {
      const chat = byConversation(String(params['conversationId']));
      if (chat !== undefined) server.commands.push(chat.id);
      return HttpResponse.json(TakeoverCommandDto.parse({ line }));
    }),
    http.post(daemonUrl('/conversations/:conversationId/hand-back'), ({ params }) => {
      const id = move(String(params['conversationId']), 'idle_cold');
      if (id !== null) server.handedBack.push(id);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(daemonUrl('/settings/sessions'), () =>
      HttpResponse.json({ notifyReplies: true, terminalApp: app }),
    ),
    http.patch(daemonUrl('/settings/sessions'), async ({ request }) => {
      server.settingsPatches.push(await request.json());
      return HttpResponse.json({ notifyReplies: true, terminalApp: app });
    }),
  );
  return server;
}
