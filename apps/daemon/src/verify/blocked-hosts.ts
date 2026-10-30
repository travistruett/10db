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
 * Reads a sandboxed gate's stderr for the hosts srt's proxy refused, and keeps srt's debug log out of
 * the gate's output: the log holds the settings and the command line with the project env, which the
 * evidence has no use for. Feed it chunks; it answers the text to keep and remembers each blocked host
 * once.
 */
export interface BlockedHostFilter {
  /** The part of the chunk that is the command's own output, whole lines only. */
  push(chunk: string): string;
  /** What is left in the buffer when the stream ends. */
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
  let buffer = '';
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

  return {
    push(chunk) {
      buffer += chunk;
      const lines = buffer.split(/(?<=\n)/);
      buffer = lines.at(-1)?.endsWith('\n') === false ? (lines.pop() ?? '') : '';
      return lines.map(keep).join('');
    },
    end() {
      const rest = buffer;
      buffer = '';
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
