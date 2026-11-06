import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

/**
 * One answer of the fake model: JavaScript for Codex's code-mode `exec` tool, which calls tools such
 * as `tools.exec_command({ cmd })` and `tools.apply_patch(patch)` and reports with `text(...)`, or a
 * message that ends the turn.
 */
export type FakeStep = { readonly js: string } | { readonly say: string };

/** What the model was sent in one request for a script. */
export interface FakeRequest {
  /** The text of every user message in the input, the whole thread's. */
  readonly userTexts: readonly string[];
  /** The text each `exec` call returned since the script's prompt, in order. */
  readonly outputs: readonly string[];
}

/** A stand-in for the Responses API that a Codex `model_providers` entry points at. */
export interface FakeResponses {
  /** The provider's `base_url`. */
  readonly baseUrl: string;
  /** Holds `steps` and returns the prompt that plays them: each request answers with the next step. */
  script(steps: readonly FakeStep[]): string;
  /** The latest request for the script `prompt` plays, once one came. */
  lastRequest(prompt: string): FakeRequest | undefined;
  close(): Promise<void>;
}

const MARKER = /FAKE-STEPS:([0-9a-f-]{36})/;

const Content = z.union([
  z.string(),
  z.array(z.looseObject({ type: z.string().optional(), text: z.string().optional() })),
]);
const InputItem = z.looseObject({
  type: z.string().optional(),
  role: z.string().optional(),
  content: Content.optional(),
  output: Content.optional(),
});
const ResponsesBody = z.looseObject({ input: z.array(InputItem).default([]) });
type InputItem = z.infer<typeof InputItem>;

function textOf(content: z.infer<typeof Content> | undefined): string {
  if (content === undefined) return '';
  if (typeof content === 'string') return content;
  return content.map((part) => part.text ?? '').join('\n');
}

const isUserMessage = (item: InputItem): boolean =>
  (item.type === undefined || item.type === 'message') && item.role === 'user';

const isCallOutput = (item: InputItem): boolean => item.type?.endsWith('_call_output') === true;

/** The SSE stream of one response: the step's item, then a completion with token usage. */
function answer(res: ServerResponse, step: FakeStep, n: number): void {
  const send = (event: Record<string, unknown> & { readonly type: string }): void => {
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  const id = `resp_${String(n)}`;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send({ type: 'response.created', response: { id } });
  const item =
    'js' in step
      ? {
          type: 'custom_tool_call',
          id: `ctc_${String(n)}`,
          call_id: `call_${String(n)}`,
          name: 'exec',
          input: step.js,
        }
      : {
          type: 'message',
          role: 'assistant',
          id: `msg_${String(n)}`,
          content: [{ type: 'output_text', text: step.say }],
        };
  send({ type: 'response.output_item.done', item });
  send({
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 10 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 120,
      },
    },
  });
  res.end();
}

async function readBody(req: IncomingMessage): Promise<string> {
  req.setEncoding('utf8');
  let body = '';
  for await (const chunk of req) body += String(chunk);
  return body;
}

/**
 * Starts the stand-in on a free loopback port. A request plays the script whose marker is in the
 * thread's latest prompt that names one, at the step after the tool outputs that followed it; a
 * request that names no script, or runs past its end, is answered with a message.
 */
export async function startFakeResponses(): Promise<FakeResponses> {
  const scripts = new Map<string, readonly FakeStep[]>();
  const latest = new Map<string, FakeRequest>();
  let served = 0;

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);
    if (req.method !== 'POST' || req.url?.endsWith('/responses') !== true) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    const parsed = ResponsesBody.safeParse(JSON.parse(body));
    const items = parsed.success ? parsed.data.input : [];
    served += 1;
    let at = -1;
    let marker: string | null = null;
    for (const [index, item] of items.entries()) {
      const found = isUserMessage(item) ? MARKER.exec(textOf(item.content)) : null;
      if (found?.[1] !== undefined) {
        at = index;
        marker = found[1];
      }
    }
    const outputs = items
      .slice(at + 1)
      .filter(isCallOutput)
      .map((item) => textOf(item.output));
    const steps = marker === null ? undefined : scripts.get(marker);
    if (marker !== null) {
      latest.set(marker, {
        userTexts: items.filter(isUserMessage).map((item) => textOf(item.content)),
        outputs,
      });
    }
    answer(res, steps?.[outputs.length] ?? { say: 'finished' }, served);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  // A listening TCP server's address is always an AddressInfo.
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    script(steps) {
      const id = randomUUID();
      scripts.set(id, steps);
      return `FAKE-STEPS:${id}`;
    },
    lastRequest(prompt) {
      const id = MARKER.exec(prompt)?.[1];
      return id === undefined ? undefined : latest.get(id);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
