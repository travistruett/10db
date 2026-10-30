/** The prefix srt gives every line of its debug log, which it writes to stderr when `SRT_DEBUG` is set. */
const DEBUG_PREFIX = '[SandboxDebug]';
const BLOCKED = /^\[SandboxDebug\] Connection blocked to (.+):\d+\s*$/;
/** A line that continues a multi-line debug message, such as the settings dumped as indented JSON. */
const CONTINUATION = /^(?:\s|[{}[\]"])/;
const MAX_HOSTS = 10;

/**
 * Reads a sandboxed gate's stderr for the hosts srt's proxy refused, and keeps srt's debug log out of
 * the gate's output: the log holds the settings and the command line, which the evidence has no use
 * for. Feed it chunks; it answers the text to keep and remembers each blocked host once.
 */
export interface BlockedHostFilter {
  /** The part of the chunk that is the command's own output, whole lines only. */
  push(chunk: string): string;
  /** What is left in the buffer when the stream ends. */
  end(): string;
  /** The hosts refused so far, lower case, in the order first refused. */
  blocked(): readonly string[];
}

export function createBlockedHostFilter(): BlockedHostFilter {
  const hosts: string[] = [];
  let buffer = '';
  let inDebug = false;

  function keep(line: string): string {
    const text = line.replace(/\r?\n$/, '');
    const blocked = BLOCKED.exec(text);
    if (blocked?.[1] !== undefined) {
      const host = blocked[1].replace(/^\[|\]$/g, '').toLowerCase();
      if (!hosts.includes(host) && hosts.length < MAX_HOSTS) hosts.push(host);
      inDebug = true;
      return '';
    }
    if (text.startsWith(DEBUG_PREFIX)) {
      inDebug = true;
      return '';
    }
    if (inDebug && CONTINUATION.test(text)) return '';
    inDebug = false;
    return line;
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

/** What the gate's evidence says when the sandbox blocked hosts; empty when it blocked none. */
export function blockedHostsNote(hosts: readonly string[]): string {
  if (hosts.length === 0) return '';
  const names =
    hosts.length === 1
      ? (hosts[0] ?? '')
      : `${hosts.slice(0, -1).join(', ')} and ${hosts.at(-1) ?? ''}`;
  return (
    `\n10db: The gate was blocked from reaching ${names}: ` +
    `${hosts.length === 1 ? 'it is' : 'they are'} not among the project's allowed network hosts. ` +
    'Allow it from the Inbox card, then run the gate again.\n'
  );
}
