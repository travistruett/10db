import type { LimitName, ToolCallView } from '@10db/contracts';
import type { ToolEntry } from './entry';

// The words of a tool row (sessions UI spec §7.3 and §14), one pure table per kind. A row draws
// `verb`, `target` in mono and `meta` dimmed (red when it failed); `name` is the whole row as a
// screen reader says it.

/** The Tabler icon a row draws, by name. */
export const ToolIcon = {
  Terminal: 'terminal',
  Pencil: 'pencil',
  File: 'file',
  Search: 'search',
  Plug: 'plug',
  Hierarchy: 'hierarchy',
  World: 'world',
  Tool: 'tool',
  Brain: 'brain',
} as const;
export type ToolIcon = (typeof ToolIcon)[keyof typeof ToolIcon];

export interface ToolRowWords {
  readonly icon: ToolIcon;
  readonly verb: string;
  readonly target: string | null;
  readonly meta: string | null;
  readonly tone: 'dimmed' | 'red';
  readonly name: string;
}

/** What each limit would do, as "Held back: this would …" ends. */
const LIMIT_WORDS: Readonly<Record<LimitName, string>> = {
  destroys_data: "destroy data it didn't create",
  sends_data_out: 'send data out',
  reads_secrets: 'read secrets',
  writes_live: 'write to something live',
};

/** "9 s" under a minute, then whole minutes; null for no duration. */
export function formatDuration(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 60_000) return `${String(Math.round(ms / 1000))} s`;
  return `${String(Math.max(1, Math.round(ms / 60_000)))} min`;
}

/** A duration as a screen reader says it: "9 seconds", "1 minute". */
function spokenDuration(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 60_000) {
    const s = Math.round(ms / 1000);
    return `${String(s)} ${s === 1 ? 'second' : 'seconds'}`;
  }
  const m = Math.max(1, Math.round(ms / 60_000));
  return `${String(m)} ${m === 1 ? 'minute' : 'minutes'}`;
}

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

/** The host a fetched address names, or the address as given when it doesn't parse. */
function hostOf(url: string): string {
  return URL.parse(url)?.host ?? url;
}

/**
 * An `other` call's title read as Plan's tool lines are written: the part before the first ` · `
 * is the tool's name, and the rest its target. A title with no ` · ` is all name.
 */
function otherParts(title: string, preview: string): { name: string; target: string | null } {
  const at = title.indexOf(' · ');
  if (at === -1)
    return { name: title === '' ? preview : title, target: preview === '' ? null : preview };
  return { name: title.slice(0, at), target: title.slice(at + 3) };
}

/** The verb, target and meta a call's kind gives, before its status adds to them. */
interface KindWords {
  readonly icon: ToolIcon;
  readonly verb: string;
  readonly target: string | null;
  readonly meta: string | null;
  /** The meta as spoken, when it differs. */
  readonly spoken?: string | null;
  /** What joins the verb and the target in the spoken name. */
  readonly join: ' ' | ': ';
  /** What joins the meta to the rest of the spoken name, when not a comma. */
  readonly metaJoin?: ' ';
}

function kindWords(call: ToolCallView, nested: number): KindWords {
  switch (call.kind) {
    case 'command': {
      const exit =
        call.status === 'failed' && call.exitCode !== null ? `exit ${String(call.exitCode)}` : null;
      const time = formatDuration(call.durationMs);
      const spokenTime = spokenDuration(call.durationMs);
      return {
        icon: ToolIcon.Terminal,
        verb: call.status === 'running' ? 'Running' : 'Ran',
        target: call.command,
        meta: [exit, time].filter((p) => p !== null).join(' · ') || null,
        spoken: [exit, spokenTime].filter((p) => p !== null).join(', ') || null,
        join: ' ',
      };
    }
    case 'edit': {
      const counts = `+${String(call.addedLines)} −${String(call.removedLines)}`;
      switch (call.change) {
        case 'add':
          return {
            icon: ToolIcon.Pencil,
            verb: 'Created',
            target: call.path,
            meta: counts,
            join: ' ',
          };
        case 'delete':
          return {
            icon: ToolIcon.Pencil,
            verb: 'Deleted',
            target: call.path,
            meta: counts,
            join: ' ',
          };
        case 'move':
          return {
            icon: ToolIcon.Pencil,
            verb: 'Moved',
            target: call.path,
            meta: call.movePath === null ? null : `to ${call.movePath}`,
            join: ' ',
            metaJoin: ' ',
          };
        case 'update':
          return {
            icon: ToolIcon.Pencil,
            verb: 'Edited',
            target: call.path,
            meta: counts,
            join: ' ',
          };
      }
      break;
    }
    case 'read':
      return { icon: ToolIcon.File, verb: 'Read', target: call.path, meta: null, join: ' ' };
    case 'search':
      return {
        icon: ToolIcon.Search,
        verb: 'Searched for',
        target: call.pattern,
        meta: call.matchCount === null ? null : plural(call.matchCount, 'match', 'matches'),
        join: ' ',
      };
    case 'mcp':
      return {
        icon: ToolIcon.Plug,
        verb: `${call.server} · ${call.tool}`,
        target: call.argumentsPreview === '' ? null : call.argumentsPreview,
        meta: null,
        join: ': ',
      };
    case 'subagent': {
      const parts = [plural(nested, 'call', 'calls'), formatDuration(call.durationMs), call.model];
      return {
        icon: ToolIcon.Hierarchy,
        verb: 'Subagent:',
        target: call.promptPreview,
        meta: parts.filter((p) => p !== null).join(' · '),
        join: ' ',
      };
    }
    case 'web':
      return call.url !== null && call.query === null
        ? { icon: ToolIcon.World, verb: 'Fetched', target: hostOf(call.url), meta: null, join: ' ' }
        : {
            icon: ToolIcon.World,
            verb: 'Searched the web for',
            target: `‘${call.query ?? ''}’`,
            meta: null,
            join: ' ',
          };
    case 'other': {
      const { name, target } = otherParts(call.title, call.inputPreview);
      return { icon: ToolIcon.Tool, verb: `Used ${name}`, target, meta: null, join: ': ' };
    }
  }
}

/** What a denied call's row says, by who denied it. */
function deniedMeta(call: ToolCallView): string | null {
  switch (call.deniedBy) {
    case '10db':
      return '10db stopped this';
    case 'builder':
      return 'You denied this';
    case 'judge':
      return call.limit === null
        ? 'Held back at a limit'
        : `Held back: this would ${LIMIT_WORDS[call.limit]}`;
    case null:
      return null;
  }
}

/** The words of one call's row. `nested` counts a subagent's calls. */
export function toolRowWords(call: ToolCallView, nested = 0): ToolRowWords {
  const kind = kindWords(call, nested);
  const said = kind.target === null ? kind.verb : `${kind.verb}${kind.join}${kind.target}`;
  if (call.status === 'denied') {
    const meta = deniedMeta(call);
    const why = [meta ?? 'denied', call.refusal].filter((p) => p !== null && p !== '');
    return { ...kind, meta, tone: 'dimmed', name: [said, ...why].join(', ') };
  }
  const failed = call.status === 'failed' || (call.kind === 'mcp' && call.error !== null);
  const spoken = kind.spoken === undefined ? kind.meta : kind.spoken;
  const status = call.kind === 'command' && failed ? `${said}, failed` : said;
  return {
    icon: kind.icon,
    verb: kind.verb,
    target: kind.target,
    meta: kind.meta,
    tone: failed ? 'red' : 'dimmed',
    name: spoken === null ? status : `${status}${kind.metaJoin ?? ', '}${spoken}`,
  };
}

/** A folded run of reads and searches: "Read 5 files, searched 2 times", or what it reads now. */
export function groupWords(entries: readonly ToolEntry[]): { text: string; name: string } {
  const last = entries.at(-1)?.call;
  if (last?.status === 'running') {
    const text =
      last.kind === 'read'
        ? `Reading ${last.path}`
        : last.kind === 'search'
          ? `Searching for ${last.pattern}`
          : 'Reading';
    return { text, name: text };
  }
  const reads = entries.filter((e) => e.call.kind === 'read').length;
  const searches = entries.filter((e) => e.call.kind === 'search').length;
  const read = reads === 0 ? null : `Read ${plural(reads, 'file', 'files')}`;
  const searched =
    searches === 0
      ? null
      : `${read === null ? 'Searched' : 'searched'} ${plural(searches, 'time', 'times')}`;
  const text = [read, searched].filter((p) => p !== null).join(', ');
  return { text, name: text };
}

/** A folded run of edits: "Edited 5 files · +40 −12". */
export function editGroupWords(entries: readonly ToolEntry[]): { text: string; name: string } {
  let added = 0;
  let removed = 0;
  for (const { call } of entries)
    if (call.kind === 'edit') {
      added += call.addedLines;
      removed += call.removedLines;
    }
  const files = `Edited ${plural(entries.length, 'file', 'files')}`;
  const counts = `+${String(added)} −${String(removed)}`;
  return { text: `${files} · ${counts}`, name: `${files}, ${counts}` };
}
