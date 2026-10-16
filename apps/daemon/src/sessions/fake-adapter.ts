import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Provider, type SessionId } from '@10db/contracts';
import { z } from 'zod';
import type { GuardVerdict } from '../guard';
import { matchesAllowedTool } from '../permissions';
import { createChannel } from './channel';
import type {
  SessionAdapter,
  SessionEvent,
  SessionHandle,
  SessionSpec,
  ToolDecision,
} from './types';

const Json: z.ZodType = z.json();

export const FakeStep = z.discriminatedUnion('do', [
  z.object({ do: z.literal('context'), percentage: z.number().min(0).max(100) }),
  z.object({ do: z.literal('activity'), summary: z.string() }),
  z.object({ do: z.literal('tool'), toolName: z.string(), input: z.record(z.string(), Json) }),
  z.object({ do: z.literal('mcp'), tool: z.string(), args: z.record(z.string(), Json) }),
  z.object({ do: z.literal('await_message'), contains: z.string() }),
  z.object({ do: z.literal('turn_complete') }),
  z.object({
    do: z.literal('rate_limit'),
    status: z.enum(['allowed', 'allowed_warning', 'rejected']),
    resetsInSeconds: z.number().nullable(),
  }),
  z.object({ do: z.literal('compact') }),
  z.object({ do: z.literal('crash'), message: z.string() }),
  z.object({ do: z.literal('hang') }),
  z.object({ do: z.literal('end') }),
]);
export type FakeStep = z.infer<typeof FakeStep>;

/** Task title → one step list per session, indexed by the session's sequence within its workstream. */
export const FakeScriptBook = z.record(z.string(), z.array(z.array(FakeStep)));
export type FakeScriptBook = z.infer<typeof FakeScriptBook>;

export interface FakeObservation {
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly title: string;
  readonly step: number;
  readonly kind: 'denied_by_guard' | 'tool_allowed' | 'tool_denied' | 'mcp_result';
  readonly detail: Record<string, unknown>;
}

/** Stands in for Claude Code at the adapter boundary; scripts drive every event. */
export class FakeAdapter implements SessionAdapter {
  readonly provider = Provider.Claude;
  readonly observations: FakeObservation[] = [];
  readonly prompts: {
    sessionId: SessionId;
    sequence: number;
    title: string;
    prompt: string;
    resume: string | null;
  }[] = [];

  private readonly book: FakeScriptBook;

  constructor(book: FakeScriptBook) {
    this.book = book;
  }

  start(spec: SessionSpec): SessionHandle {
    const title = Object.keys(this.book).find((t) => spec.prompt.includes(`Task: ${t}\n`)) ?? '';
    const steps = this.book[title]?.[spec.sequence - 1];
    this.prompts.push({
      sessionId: spec.sessionId,
      sequence: spec.sequence,
      title,
      prompt: spec.prompt,
      resume: spec.resumeProviderSessionId,
    });

    const channel = createChannel<SessionEvent>();
    const abort = new AbortController();
    const messages: string[] = [];
    let messageWaiter: (() => void) | null = null;
    let ended = false;
    let mcp: Client | null = null;
    let finished: () => void = () => undefined;
    const done = new Promise<void>((r) => {
      finished = r;
    });

    const end = (
      reason: 'completed' | 'stopped' | 'error' | 'rate_limited',
      message: string | null,
    ): void => {
      if (ended) return;
      ended = true;
      channel.push({ type: 'ended', reason, message });
      channel.end();
      void mcp?.close();
      finished();
    };
    const untilStopped = new Promise<'stopped'>((r) => {
      abort.signal.addEventListener('abort', () => {
        r('stopped');
      });
    });
    const observe = (
      step: number,
      kind: FakeObservation['kind'],
      detail: Record<string, unknown>,
    ): void => {
      this.observations.push({
        sessionId: spec.sessionId,
        sequence: spec.sequence,
        title,
        step,
        kind,
        detail,
      });
    };

    // A throwing guard denies: the tool call must never proceed on a guard failure.
    const guardVerdict = (toolName: string, input: Record<string, unknown>): GuardVerdict => {
      try {
        return spec.preToolUse({ toolName, input });
      } catch (error) {
        return {
          decision: 'deny',
          reason: `guard failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };

    const applyFileEffect = (toolName: string, input: Record<string, unknown>): void => {
      const file =
        typeof input['file_path'] === 'string' ? resolve(spec.cwd, input['file_path']) : null;
      if (!file) return;
      if (toolName === 'Write' && typeof input['content'] === 'string') {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, input['content']);
      }
      if (
        toolName === 'Edit' &&
        typeof input['old_string'] === 'string' &&
        typeof input['new_string'] === 'string'
      ) {
        writeFileSync(
          file,
          readFileSync(file, 'utf8').replace(input['old_string'], input['new_string']),
        );
      }
    };

    const callMcp = async (
      tool: string,
      args: Record<string, unknown>,
    ): Promise<{ isError: boolean; text: string }> => {
      if (!mcp) {
        mcp = new Client({ name: 'fake-claude', version: '0.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(spec.mcp.url), {
          requestInit: { headers: { Authorization: `Bearer ${spec.mcp.token}` } },
        });
        // The SDK class declares `sessionId?: string`, which `Transport` rejects under exactOptionalPropertyTypes.
        await mcp.connect(transport as Transport);
      }
      const result = await mcp.callTool({ name: tool, arguments: args }, undefined, {
        timeout: spec.mcp.toolTimeoutMs,
        signal: abort.signal,
      });
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : ''))
        .join('');
      return { isError: result.isError === true, text };
    };

    const runStep = async (step: FakeStep, index: number): Promise<'continue' | 'halt'> => {
      switch (step.do) {
        case 'context':
          channel.push({
            type: 'context',
            percentage: step.percentage,
            totalTokens: step.percentage * 2000,
            maxTokens: 200_000,
          });
          return 'continue';
        case 'activity':
          channel.push({ type: 'activity', kind: 'text', summary: step.summary });
          return 'continue';
        case 'tool': {
          const input = step.input;
          channel.push({ type: 'activity', kind: 'tool', summary: step.toolName });
          const verdict = guardVerdict(step.toolName, input);
          if (verdict.decision === 'deny') {
            observe(index, 'denied_by_guard', { reason: verdict.reason });
            return 'continue';
          }
          let decision: ToolDecision = { behavior: 'allow' };
          if (
            step.toolName === 'AskUserQuestion' ||
            !matchesAllowedTool(step.toolName, input, spec.allowedTools, spec.cwd)
          ) {
            const asked = await Promise.race([
              spec.canUseTool({
                toolName: step.toolName,
                input,
                toolUseId: `fake-tool-${String(index)}`,
                signal: abort.signal,
              }),
              untilStopped,
            ]);
            if (asked === 'stopped') return 'halt';
            decision = asked;
          }
          if (decision.behavior === 'deny') {
            observe(index, 'tool_denied', { toolName: step.toolName, message: decision.message });
            return 'continue';
          }
          const effective = decision.updatedInput ?? input;
          applyFileEffect(step.toolName, effective);
          observe(index, 'tool_allowed', {
            toolName: step.toolName,
            ...(effective['answers'] ? { answers: effective['answers'] } : {}),
          });
          return 'continue';
        }
        case 'mcp': {
          const result = await Promise.race([callMcp(step.tool, step.args), untilStopped]);
          if (result === 'stopped') return 'halt';
          observe(index, 'mcp_result', {
            tool: step.tool,
            isError: result.isError,
            text: result.text,
          });
          return 'continue';
        }
        case 'await_message': {
          for (;;) {
            if (messages.some((m) => m.includes(step.contains))) return 'continue';
            const woke = await Promise.race([
              new Promise<'message'>((r) => {
                messageWaiter = () => {
                  r('message');
                };
              }),
              untilStopped,
            ]);
            if (woke === 'stopped') return 'halt';
          }
        }
        case 'turn_complete':
          channel.push({
            type: 'turn_complete',
            inputTokens: 1000,
            outputTokens: 200,
            costUsd: 0.01,
          });
          return 'continue';
        case 'rate_limit':
          channel.push({
            type: 'rate_limit',
            status: step.status,
            resetsAt:
              step.resetsInSeconds === null
                ? null
                : new Date(Date.now() + step.resetsInSeconds * 1000),
          });
          if (step.status === 'rejected') {
            end('rate_limited', 'usage limit reached');
            return 'halt';
          }
          return 'continue';
        case 'compact':
          channel.push({ type: 'compacted', trigger: 'auto' });
          return 'continue';
        case 'crash':
          end('error', step.message);
          return 'halt';
        case 'hang':
          await untilStopped;
          return 'halt';
        case 'end':
          end('completed', null);
          return 'halt';
      }
    };

    void (async () => {
      channel.push({
        type: 'started',
        providerSessionId: spec.resumeProviderSessionId ?? `fake-${spec.sessionId}`,
        pid: null,
      });
      if (!steps) {
        end('error', `No fake script for "${title}" session ${String(spec.sequence)}`);
        return;
      }
      try {
        // Every step that ends the session returns 'halt', so only a stop needs checking here.
        for (const [index, step] of steps.entries()) {
          if (abort.signal.aborted) break;
          if ((await runStep(step, index)) === 'halt') break;
        }
        end(abort.signal.aborted ? 'stopped' : 'completed', null);
      } catch (error) {
        end(
          abort.signal.aborted ? 'stopped' : 'error',
          error instanceof Error ? error.message : String(error),
        );
      }
    })();

    return {
      events: channel,
      send(text) {
        messages.push(text);
        messageWaiter?.();
        messageWaiter = null;
      },
      async stop() {
        abort.abort();
        end('stopped', null);
        await done;
      },
    };
  }
}
