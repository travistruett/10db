import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FakeShapeBehaviour } from './fake-session';

/** How the planning rules owed to a session that began without a plan start. */
const OWED_RULES = '[planning rules]';
// Anchored to a line start: the planning rules a message may carry ahead of it quote the form "[m:ID] text".
const BUILDER_MESSAGE_ID = /^\[m:([^\]]+)\]/m;
/** An intake line naming a file the builder dropped: `[file] <path> (<name>)`, with an optional reason after. */
const DROPPED_FILE = /^\[file\] (.*) \((.+?)\)(?: — .*)?$/gm;
/** A message that asks for the plan: the scripted agent proposes it as things are decided. */
const ASKS_TO_PROPOSE = /\bpropose\b/i;
const MAX_HEARD_ITEMS = 5;
const MAX_HEARD_CHARS = 80;
/** What the project's areas are, when a draft names one it hasn't got: "(it has src, ui)". */
const AREAS_OF_THE_PROJECT = /\(it has ([^)]+)\)/;

/** A Plan review turn lists `- effortKey <key> · <title>`; a Check for Questions turn `- effortKey <e> · taskKey <t> · taskHash <h>`. */
const REVIEW_EFFORT = /^- effortKey (\S+)/gm;
const REHEARSE_TASK = /^- effortKey (\S+) · taskKey (\S+) · taskHash (\S+)/gm;
/** A Design review turn lists `- effortKey <e> · taskKey <t>` for each task it compares. */
const DESIGN_TASK = /^- effortKey (\S+) · taskKey (\S+)/gm;
/** "mock it up" attaches a small mockup to the scripted goal's first task. */
const MOCK_IT_UP = /\bmock it up\b/i;
const MOCKUP_HTML = '<main><h1>Dense board</h1><p>Cards sit closer together.</p></main>';

/** "show a fence" asks for a reply with a code fence and a link, which the UI draws as markdown. */
const SHOW_A_FENCE = /\bshow a fence\b/i;
const FENCE_REPLY = [
  'Here is the client:',
  '',
  '```ts',
  'export const retries: number = 3; // three tries',
  '```',
  '',
  'See [docs](https://example.com/docs).',
].join('\n');

/** "see the board", "see the task tsk_…", each with an optional "at 900": a look at one of the app's screens. */
const SEE_SCREEN = /\bsee the (factory|board|inbox|plan|task (\S+))(?: at (\d+))?/i;

/** What the scripted draft proposes, citing the builder's messages; every task is in `area`. */
function scriptedDraft(area: string, sources: readonly string[]): Record<string, unknown> {
  const task = (key: string, title: string) => ({
    key,
    title,
    criteria: [`${title} is done`],
    areas: [area],
    size: 'S',
  });
  return {
    goals: [
      {
        key: 'board-polish',
        title: 'Board polish',
        objective: 'The board is denser and calmer to scan.',
        ceremony: 'direct',
        criteria: [],
        sourceMessageIds: sources,
        tasks: [task('density', 'Compact card density'), task('scrollbars', 'Thin scrollbars')],
      },
    ],
    looseTasks: [
      {
        ...task('abandon-strip', 'Drop the Abandon strip'),
        ceremony: 'direct',
        sourceMessageIds: sources,
      },
      {
        ...task('failed-label', 'Say "failed" in plain words'),
        ceremony: 'direct',
        sourceMessageIds: sources,
      },
    ],
    records: [
      {
        key: 'plain-words',
        kind: 'decision',
        scope: 'project',
        question: 'How does a failure read?',
        choice: 'In plain words, with what Retry will do',
        rationale: 'The builder acts on a sentence, not a status.',
        sourceMessageIds: sources,
      },
    ],
  };
}

/**
 * A Shape session that answers like a small, deterministic Claude, for the e2e and for a daemon on the
 * fake adapter: it echoes what it heard with `note_heard` and replies, naming each file dropped with
 * the message; a message that says "propose" gets a plan (one goal with two tasks, two loose tasks,
 * one decision) through `propose_plan`, in the project's
 * first area, learning the area from the refusal when the draft's first guess is wrong. Asked to
 * "show a fence", it answers with a code fence and a link, for the window's CSP e2e row.
 *
 * It works in a session with no plan too: `note_heard` answers and writes nothing, and "propose" makes the
 * plan through the same handler. It says "I have <name>." of a dropped file only when its own PreToolUse
 * hook lets it Read the stored path, and "I could not read <name>." otherwise, so a check of the file proves
 * the folder is readable. The builder's message id is the `[m:ID]` that opens a line: the owed planning
 * rules `outgoing` puts first quote the form in the middle of a line, and are not an id.
 */
export function scriptedShapeBehaviour(): FakeShapeBehaviour {
  /** The builder's message ids each conversation has seen, as a proposal may cite them. */
  const heard = new Map<string, string[]>();
  return async (turn) => {
    const client = new Client({ name: 'fake-claude', version: '0.0.0' });
    const call = async (
      tool: string,
      args: Record<string, unknown>,
    ): Promise<{ isError: boolean; text: string; images: number }> => {
      const result = await client.callTool({ name: tool, arguments: args }, undefined, {
        timeout: turn.spec.mcp.toolTimeoutMs,
        signal: turn.signal,
      });
      const content = (Array.isArray(result.content) ? result.content : []) as {
        type?: string;
        text?: string;
      }[];
      const text = content.map((c) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
      return {
        isError: result.isError === true,
        text,
        images: content.filter((c) => c.type === 'image').length,
      };
    };
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(turn.spec.mcp.url), {
          requestInit: { headers: { Authorization: `Bearer ${turn.spec.mcp.token}` } },
        }),
      );
      const ids = heard.get(turn.spec.conversationId ?? turn.spec.sessionId) ?? [];
      heard.set(turn.spec.conversationId ?? turn.spec.sessionId, ids);
      // The message's id goes first, so a proposal made in this very turn can cite it.
      const id = BUILDER_MESSAGE_ID.exec(turn.message)?.[1];
      if (id !== undefined) ids.push(id);
      // The planning rules a session owes come first and say "propose" themselves: only what follows them,
      // from the first dropped file or the message's id, is the builder's.
      const rulesEnd = turn.message.startsWith(OWED_RULES)
        ? turn.message.search(/^\[(?:file\] |m:)/m)
        : 0;
      const text = (rulesEnd < 0 ? turn.message : turn.message.slice(rulesEnd)).replace(
        BUILDER_MESSAGE_ID,
        '',
      );
      // The two review turns the Review menu sends. The script reports as the reviewers do; its MCP calls
      // bypass the session's hook, which stamps the reviewer from the subagent's type.
      const trimmed = text.trim();
      if (trimmed.startsWith('Plan review:')) {
        const efforts = [...trimmed.matchAll(REVIEW_EFFORT)].map((m) => m[1] ?? '');
        for (const effortKey of efforts)
          await call('report_finding', {
            effortKey,
            reviewer: 'scope',
            finding: {
              kind: 'finding',
              severity: 'medium',
              text: 'The scope is wider than one pull request.',
            },
          });
        return { text: `Reviewed ${String(efforts.length)}.` };
      }
      if (trimmed.startsWith('Design review:')) {
        const tasks = [...trimmed.matchAll(DESIGN_TASK)];
        for (const [, effortKey, taskKey] of tasks)
          await call('report_finding', {
            effortKey,
            taskKey,
            reviewer: 'design',
            finding: {
              kind: 'finding',
              severity: 'low',
              text: 'The mock-up leaves out the empty state.',
            },
          });
        return { text: `Compared ${String(tasks.length)}.` };
      }
      if (trimmed.startsWith('Rehearse:')) {
        const tasks = [...trimmed.matchAll(REHEARSE_TASK)];
        for (const [, effortKey, taskKey, taskHash] of tasks)
          await call('report_finding', {
            effortKey,
            taskKey,
            taskHash,
            reviewer: 'rehearsal',
            final: true,
            finding: { kind: 'question', text: 'Which screen does this change first?' },
          });
        return { text: `Read ${String(tasks.length)}.` };
      }
      if (MOCK_IT_UP.test(text)) {
        const answer = await call('attach', {
          target: { key: 'density' },
          attachment: { kind: 'mockup', html: MOCKUP_HTML },
        });
        return { text: answer.isError ? 'I could not attach it.' : 'Here is a mock-up.' };
      }
      if (ASKS_TO_PROPOSE.test(text)) {
        if (ids.length === 0) return { text: 'There is nothing to propose from yet.' };
        let area = 'repo';
        let answer = await call('propose_plan', { draft: scriptedDraft(area, ids) });
        const names = AREAS_OF_THE_PROJECT.exec(answer.text)?.[1];
        const first = names?.split(',')[0]?.trim();
        if (answer.isError && first !== undefined && first !== '') {
          area = first;
          answer = await call('propose_plan', { draft: scriptedDraft(area, ids) });
        }
        return { text: answer.isError ? 'I could not state a plan.' : 'Here is the plan.' };
      }
      // "See the board at 900" asks for a screen, as a session planning UI work would.
      const look = SEE_SCREEN.exec(text);
      if (look !== null) {
        const screen = (look[1] ?? '').toLowerCase();
        const taskId = look[2];
        const answer = await call('see_screen', {
          screen: taskId === undefined ? screen : 'task',
          ...(taskId === undefined ? {} : { taskId }),
          ...(look[3] === undefined ? {} : { width: Number(look[3]) }),
        });
        return {
          text: answer.isError
            ? `I could not see it: ${answer.text}`
            : `I saw the ${screen}: ${String(answer.images)} picture.`,
        };
      }
      if (SHOW_A_FENCE.test(text)) return { text: FENCE_REPLY };
      const items = text
        .split(/[\n.]+/)
        .map((s) => s.trim())
        .filter((s) => s !== '')
        .slice(0, MAX_HEARD_ITEMS)
        .map((s) => s.slice(0, MAX_HEARD_CHARS));
      await call('note_heard', { items });
      // A file counts as read only when the session's own hook lets it Read the stored path.
      const files = [...turn.message.matchAll(DROPPED_FILE)].map((m) => {
        const name = m[2] ?? '';
        const verdict = turn.guard({ toolName: 'Read', input: { file_path: m[1] ?? '' } });
        return verdict.decision === 'allow' ? ` I have ${name}.` : ` I could not read ${name}.`;
      });
      return {
        text: `Noted ${String(items.length)} ${items.length === 1 ? 'thing' : 'things'}.${files.join('')}`,
      };
    } finally {
      await client.close();
    }
  };
}
