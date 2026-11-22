// A book script cannot know the ids the daemon mints, so a step names a task by title: `$task:<title>`
// in an `mcp` step's arguments becomes the id a tool result showed for that title (a created task's
// `taskId`, or a task list's `id`). The Linear reporter's script names the updates its brief lists by
// `$owed`, an array element that becomes the post ids the prompt's brief lists as owed.

const REF = /^\$task:(.+)$/s;
const OWED = '$owed';
// A line of the brief's owed updates: `- <post id>: <event>, attempt <n>, {detail}`; a recorded one has `comments [` instead.
const OWED_LINE = /^- (lnp_[0-9a-f-]{36}): [a-z_]+, attempt \d+, \{/gm;

export class FakeTaskRefs {
  private readonly ids = new Map<string, string>();
  private readonly owed: string[];

  constructor(prompt = '') {
    this.owed = [...prompt.matchAll(OWED_LINE)].map((m) => m[1] ?? '');
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

  private swap(value: unknown): unknown {
    if (typeof value === 'string') {
      const title = REF.exec(value)?.[1];
      return (title === undefined ? undefined : this.ids.get(title)) ?? value;
    }
    if (Array.isArray(value))
      return value.flatMap((item: unknown) => (item === OWED ? this.owed : [this.swap(item)]));
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
    const id = record['taskId'] ?? record['id'];
    if (typeof record['title'] === 'string' && typeof id === 'string')
      this.ids.set(record['title'], id);
    for (const inner of Object.values(record)) this.walk(inner);
  }
}
