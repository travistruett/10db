import { WatchpointFileStatus } from '@10db/contracts';

/** One file's part of a unified diff: its header and hunks, cut to a size cap. */
export interface PatchSection {
  readonly path: string;
  readonly status: WatchpointFileStatus;
  readonly patch: string;
  /** True when the section was cut, by the cap or because the diff itself ended inside it. */
  readonly clipped: boolean;
}

const HEADER = 'diff --git ';
const MODE_LINES = 12;

/** What `\x` stands for in a path git quotes. */
const ESCAPES: Readonly<Record<string, string>> = {
  a: '\x07',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};

/** A C-style quoted path (git quotes names with unusual bytes), as the UTF-8 text it spells. */
function unquote(quoted: string): string {
  const bytes: number[] = [];
  const inner = quoted.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const ch = inner.charAt(i);
    if (ch !== '\\') {
      bytes.push(...Buffer.from(ch, 'utf8'));
      continue;
    }
    const next = inner.charAt(++i);
    const octal = /^[0-7]{3}/.exec(inner.slice(i, i + 3));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 2;
    } else bytes.push(...Buffer.from(ESCAPES[next] ?? next, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * The path a `diff --git a/<p> b/<p>` line names. Diffs are read without renames, so both sides name one path.
 * Null for a line that doesn't fit that shape.
 */
function headerPath(line: string): string | null {
  const rest = line.slice(HEADER.length);
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" "b/');
    if (end < 0) return null;
    const first = unquote(rest.slice(0, end + 1));
    return first.startsWith('a/') ? first.slice(2) : null;
  }
  const half = (rest.length - 1) / 2;
  if (!Number.isInteger(half) || half < 3) return null;
  const left = rest.slice(0, half);
  return left.startsWith('a/') && rest.slice(half) === ` b/${left.slice(2)}` ? left.slice(2) : null;
}

function statusOf(section: string): WatchpointFileStatus {
  const head = section.split('\n', MODE_LINES);
  if (head.some((l) => l.startsWith('new file mode'))) return WatchpointFileStatus.Added;
  if (head.some((l) => l.startsWith('deleted file mode'))) return WatchpointFileStatus.Deleted;
  return WatchpointFileStatus.Modified;
}

/** `text` cut to at most `bytes` of UTF-8 at a line end, and whether anything was cut. */
function cutToBytes(text: string, bytes: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= bytes) return { text, cut: false };
  const head = Buffer.from(text, 'utf8').subarray(0, bytes).toString('utf8');
  return { text: head.slice(0, head.lastIndexOf('\n') + 1), cut: true };
}

/**
 * A unified diff as one section per file, each cut to `fileBytes`. `diffCut` says the diff itself was
 * cut, so its last section is clipped too. A file that several ranges changed has its sections joined.
 */
export function splitPatch(
  diff: string,
  limits: { readonly fileBytes: number; readonly diffCut: boolean },
): Map<string, PatchSection> {
  const sections = diff.split(/^(?=diff --git )/m).filter((s) => s.startsWith(HEADER));
  const found = new Map<string, PatchSection>();
  sections.forEach((section, index) => {
    const path = headerPath(section.split('\n', 1)[0] ?? '');
    if (path === null) return;
    const before = found.get(path);
    const room = limits.fileBytes - Buffer.byteLength(before?.patch ?? '', 'utf8');
    const kept = cutToBytes(section, Math.max(room, 0));
    const clipped = kept.cut || (limits.diffCut && index === sections.length - 1);
    found.set(path, {
      path,
      status: before?.status ?? statusOf(section),
      patch: (before?.patch ?? '') + kept.text,
      clipped: (before?.clipped ?? false) || clipped,
    });
  });
  return found;
}
