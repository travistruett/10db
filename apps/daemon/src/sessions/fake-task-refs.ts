// A book script cannot know the ids the daemon mints, so a step names a task by title: `$task:<title>`
// in an `mcp` step's arguments becomes the id a tool result showed for that title (a created task's
// `taskId`, or a task list's `id`). The Linear reporter's script runs its steps once for each update its
// brief lists as owed (`each_owed`), and reads back the comment 10db built for the body it handed over.

import { FakeStep } from './fake-script';

const REF = /^\$task:(.+)$/s;
// The comment 10db built for the last body the script handed it: `$comment.issueId` and `$comment.body`.
const COMMENT_REF = /^\$comment\.(\w+)$/;
// What an `each_owed` group's steps call the update they run for.
const POST = '$post';
// A line of the brief's owed updates: `- <post id>: <event>, attempt <n>, {detail}`; a recorded one has `comments [` instead.
const OWED_LINE = /^- (lnp_[0-9a-f-]{36}): [a-z_]+, attempt \d+, \{/gm;
// A Linear tool a script names without its server: `$linear:save_comment`. The server is whichever one the brief's
// tool list names first, since which servers an account's agent has depends on the machine (a builder's own Linear
// server, or the claude.ai connector).
const LINEAR_TOOL = /\$linear:(\w+)/g;
const LINEAR_PREFIX = /(mcp__[\w-]+?__)save_comment/;

export class FakeTaskRefs {
  private readonly ids = new Map<string, string>();
  private readonly owed: string[];
  private readonly linearPrefix: string | undefined;
  private readonly comment: { issueId?: string; body?: string } = {};

  constructor(prompt = '') {
    this.owed = [...prompt.matchAll(OWED_LINE)].map((m) => m[1] ?? '');
    this.linearPrefix = LINEAR_PREFIX.exec(prompt)?.[1];
  }

  /** Remembers each title and id pair in a tool result's JSON; a result that is not JSON teaches nothing. */
  learn(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    this.walk(parsed);
  }

  /** The arguments with each reference to a task replaced by its id. */
  resolve(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) out[key] = this.swap(value);
    return out;
  }

  /**
   * The script's steps with each `each_owed` group written out once per owed update, `$post` replaced by its id
   * and `$linear:<tool>` by the full name of that tool on the brief's first Linear server.
   */
  expand(steps: readonly FakeStep[]): FakeStep[] {
    return steps.flatMap((step) =>
      step.do === 'each_owed'
        ? this.owed.flatMap((id) =>
            step.steps.map((inner) =>
              FakeStep.parse(
                JSON.parse(
                  JSON.stringify(inner)
                    .replaceAll(POST, id)
                    .replaceAll(LINEAR_TOOL, (named, tool: string) =>
                      this.linearPrefix === undefined ? named : `${this.linearPrefix}${tool}`,
                    ),
                ),
              ),
            ),
          )
        : [step],
    );
  }

  private swap(value: unknown): unknown {
    if (typeof value === 'string') {
      const title = REF.exec(value)?.[1];
      if (title !== undefined) return this.ids.get(title) ?? value;
      const comment = COMMENT_REF.exec(value)?.[1];
      if (comment === 'issueId' || comment === 'body') return this.comment[comment] ?? value;
      return value;
    }
    if (Array.isArray(value)) return value.map((item: unknown) => this.swap(item));
    if (typeof value === 'object' && value !== null) return this.resolve({ ...value });
    return value;
  }

  private walk(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) this.walk(item);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record: Record<string, unknown> = { ...value };
    // The reporter's answer to a comment body: the arguments its `save_comment` must carry.
    const next = record['next'];
    const args =
      typeof next === 'object' && next !== null && 'arguments' in next ? next.arguments : null;
    if (typeof args === 'object' && args !== null) {
      if ('issueId' in args && typeof args.issueId === 'string')
        this.comment.issueId = args.issueId;
      if ('body' in args && typeof args.body === 'string') this.comment.body = args.body;
    }
    const id = record['taskId'] ?? record['id'];
    if (typeof record['title'] === 'string' && typeof id === 'string')
      this.ids.set(record['title'], id);
    for (const inner of Object.values(record)) this.walk(inner);
  }
}
