// A book script cannot know the ids the daemon mints, so a step names a task by title: `$task:<title>`
// in an `mcp` step's arguments becomes the id a tool result showed for that title (a created task's
// `taskId`, or a task list's `id`).

const REF = /^\$task:(.+)$/s;

export class FakeTaskRefs {
  private readonly ids = new Map<string, string>();

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
    const id = record['taskId'] ?? record['id'];
    if (typeof record['title'] === 'string' && typeof id === 'string')
      this.ids.set(record['title'], id);
    for (const inner of Object.values(record)) this.walk(inner);
  }
}
