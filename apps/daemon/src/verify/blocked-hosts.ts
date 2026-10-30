import { checkConcreteHost } from '../permissions';

/** The marker srt puts before every message of its debug log, which it writes to stderr when `SRT_DEBUG` is set. */
const DEBUG_MARKER = '[SandboxDebug]';
/**
 * The messages srt's proxies write when they refuse a host: `Connection blocked to` for a CONNECT
 * (http-proxy.js) or a SOCKS request (socks-proxy.js), `HTTP request blocked to` for a plain HTTP one.
 */
const BLOCKED = /^(?:Connection|HTTP request) blocked to (.+):\d+$/;
/** The message srt writes, before it starts the command, with the command line it was given. */
const COMMAND_ECHO = 'Command string mode (-c):';
/** The closing line of a message that opened a block, such as the settings srt dumps as indented JSON. */
const CLOSERS: Readonly<Record<string, RegExp>> = { '{': /^\}\s*$/, '[': /^\]\s*$/ };
const MAX_HOSTS = 10;
/**
 * Longer than any message srt writes. Its longest is the command line it echoes, which the system's
 * limit on a program's arguments (1 MiB on macOS) bounds; a partial line held longer than this is the
 * command's own output.
 */
const MAX_HELD_CHARS = 2 * 1024 * 1024;

/** True for the first half of a UTF-16 surrogate pair, which a character beyond U+FFFF takes two units of. */
function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

/**
 * Reads a sandboxed gate's stderr for the hosts srt's proxy refused, and keeps srt's debug log out of
 * the gate's output: the log holds the settings and the command line with the project env, which the
 * evidence has no use for. Feed it chunks; it answers the text to keep and remembers each blocked host
 * once.
 */
export interface BlockedHostFilter {
  /**
   * The part of the chunk that is the command's own output: whole lines, and the start of a line
   * too long to be held whole.
   */
  push(chunk: string): string;
  /** What is left of the last line when the stream ends. */
  end(): string;
  /** The hosts refused so far, lower case, in the order first refused. */
  blocked(): readonly string[];
}

export interface BlockedHostFilterOptions {
  /**
   * How many lines the command line srt is given takes (srt echoes it in its debug log, project env
   * and all). srt writes it before the command starts, so the lines after the first are srt's too.
   */
  readonly commandLines?: number;
}

export function createBlockedHostFilter(options: BlockedHostFilterOptions = {}): BlockedHostFilter {
  const hosts: string[] = [];
  /** The line the stream is part way through: everything after its last newline. */
  let held = '';
  /** Lines still to drop: the rest of an echoed command line. */
  let echoLeft = 0;
  /** The closing line of the open debug block, if one is open. */
  let closer: RegExp | null = null;

  function debugMessage(message: string): void {
    const blocked = BLOCKED.exec(message);
    if (blocked?.[1] !== undefined) {
      const host = blocked[1].replace(/^\[|\]$/g, '').toLowerCase();
      if (!hosts.includes(host) && hosts.length < MAX_HOSTS) hosts.push(host);
      return;
    }
    if (message.startsWith(COMMAND_ECHO)) {
      echoLeft = Math.max(0, (options.commandLines ?? 1) - 1);
      return;
    }
    closer = CLOSERS[message.at(-1) ?? ''] ?? null;
  }

  function keep(line: string): string {
    const ending = /\r?\n$/.exec(line)?.[0] ?? '';
    const text = line.slice(0, line.length - ending.length);
    if (echoLeft > 0) {
      echoLeft -= 1;
      return '';
    }
    if (closer !== null) {
      if (closer.test(text)) closer = null;
      return '';
    }
    // srt shares the command's stderr: its message can follow output the command left without a
    // newline (a progress meter), so the marker is looked for anywhere and only its message is cut.
    const at = text.indexOf(DEBUG_MARKER);
    if (at === -1) return line;
    debugMessage(text.slice(at + DEBUG_MARKER.length).trim());
    const before = text.slice(0, at);
    return before === '' ? '' : `${before}${ending}`;
  }

  /**
   * Lets go of a partial line held too long to be one of srt's messages, so the filter holds a
   * bounded amount: the command's text is passed on as it comes, up to where srt's message may start.
   */
  function release(): string {
    if (held.length <= MAX_HELD_CHARS) return '';
    // Inside the echoed command line or a dumped block, every line is srt's, and none is this long.
    if (echoLeft > 0 || closer !== null) {
      held = '';
      return '';
    }
    const at = held.indexOf(DEBUG_MARKER);
    // With no marker yet, the last characters may still begin one; a surrogate pair stays whole.
    let cut = at === -1 ? held.length - (DEBUG_MARKER.length - 1) : at;
    if (isHighSurrogate(held.charCodeAt(cut - 1))) cut -= 1;
    const passed = held.slice(0, cut);
    held = held.slice(cut);
    // Text this long from a marker on is no message of srt's: it is dropped, and the rest of its line
    // is read as a line of its own.
    if (held.length > MAX_HELD_CHARS) held = '';
    return passed;
  }

  return {
    push(chunk) {
      // Only the new chunk is searched for line ends, so a long line costs its length, once.
      const last = chunk.lastIndexOf('\n');
      if (last === -1) {
        held += chunk;
        return release();
      }
      const lines = `${held}${chunk.slice(0, last + 1)}`.split(/(?<=\n)/);
      held = chunk.slice(last + 1);
      return lines.map(keep).join('') + release();
    },
    end() {
      const rest = held;
      held = '';
      return rest === '' ? '' : keep(rest);
    },
    blocked: () => hosts,
  };
}

function joined(names: readonly string[]): string {
  return names.length === 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

function askable(host: string): boolean {
  try {
    checkConcreteHost(host);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the gate's evidence says when the sandbox blocked hosts; empty when it blocked none. A host the
 * project may be given is sent to the Inbox and Settings; one it may not (a bare name, this machine, a
 * pattern) is said to be so, since no card is raised for it.
 */
export function blockedHostsNote(hosts: readonly string[]): string {
  if (hosts.length === 0) return '';
  const allowable = hosts.filter(askable);
  const refused = hosts.filter((host) => !askable(host));
  const lines: string[] = [];
  if (allowable.length > 0) {
    const one = allowable.length === 1;
    lines.push(
      `10db: The gate was blocked from reaching ${joined(allowable)}: ` +
        `${one ? 'it is' : 'they are'} not among the project's allowed network hosts. ` +
        `Allow ${one ? 'it' : 'them'} for the project, from the Inbox or in Settings › Network hosts, ` +
        'then run the gate again.',
    );
  }
  if (refused.length > 0) {
    const one = refused.length === 1;
    lines.push(
      `10db: The gate was blocked from reaching ${joined(refused)}: ` +
        `${one ? "it can't be allowed as a network host" : "they can't be allowed as network hosts"} ` +
        '(a project is given whole host names such as index.crates.io, never this machine or a pattern), ' +
        `so the gate can't reach ${one ? 'it' : 'them'} from the sandbox.`,
    );
  }
  return `\n${lines.join('\n')}\n`;
}
