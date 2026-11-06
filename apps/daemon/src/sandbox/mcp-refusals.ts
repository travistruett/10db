import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock, type Clock, type Timer } from '../clock';
import type { SealedFileKind } from './sealed-file';
import { SandboxTempDirError } from './temp-dir';

/** How often a server's refusal log is read. */
const POLL_MS = 2000;

/** The preload that carries srt's refusals out of its host process. */
export const REFUSAL_PRELOAD: SealedFileKind = {
  prefix: '10db-mcp-',
  suffix: '.cjs',
  what: 'an MCP server refusal preload',
};
/** Where that preload writes the hosts srt refused; the daemon reads it. */
export const REFUSAL_LOG: SealedFileKind = {
  prefix: '10db-mcp-',
  suffix: '.log',
  what: 'an MCP server refusal log',
};

/** The most hosts one server's log holds, and so the most the daemon names for it. */
const MAX_HOSTS = 50;
const MAX_HOST_CHARS = 253;
/** What a host looks like once srt's proxy has refused it: names, and IPv6 literals without brackets. */
const HOST = /^[a-z0-9._:-]+$/;

/**
 * The source of a preload for srt's command line (`node -r <file> cli.js …`). srt writes the hosts its
 * proxy refuses to its debug log, on its own stderr (`Connection blocked to host:port`, with
 * `SRT_DEBUG` set), where Claude Code takes them with the server's output and the daemon never sees
 * them. The preload writes each refused host, once, to `logFile` and keeps every debug message of srt
 * off stderr, so Claude Code is told what it was before the log was turned on. It runs in srt's host,
 * outside the sandbox: its source holds a path the daemon chose, and no input of the server's.
 */
export function refusalPreload(logFile: string): string {
  return `'use strict';
const fs = require('node:fs');
const FILE = ${JSON.stringify(logFile)};
const MARK = '[SandboxDebug] ';
const REFUSED = /^(?:Connection|HTTP request) blocked to (.+):[0-9]+$/;
const seen = new Set();
for (const level of ['error', 'warn']) {
  const write = console[level].bind(console);
  console[level] = (...args) => {
    const text = args[0];
    if (args.length !== 1 || typeof text !== 'string' || !text.startsWith(MARK)) return write(...args);
    const refused = REFUSED.exec(text.slice(MARK.length));
    if (refused === null) return;
    const host = refused[1].replace(/^\\[|\\]$/g, '').toLowerCase();
    if (seen.has(host) || seen.size >= ${String(MAX_HOSTS)}) return;
    seen.add(host);
    try {
      fs.appendFileSync(FILE, host + '\\n');
    } catch {
      // The log is gone: the session is ending.
    }
  };
}
`;
}

/** Makes the log, empty and writable by the user only, beside the sandbox temp dirs and outside every one. */
export function createRefusalLog(root: string): string {
  const file = join(
    root,
    `${REFUSAL_LOG.prefix}${randomBytes(6).toString('hex')}${REFUSAL_LOG.suffix}`,
  );
  try {
    writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  } catch {
    throw new SandboxTempDirError(`Could not create ${REFUSAL_LOG.what}`);
  }
  return file;
}

/** The hosts in whole lines of a refusal log, lower case, once each; a line that is no host name is dropped. */
export function readRefusedHosts(text: string): string[] {
  const hosts = text
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0 && line.length <= MAX_HOST_CHARS && HOST.test(line));
  return [...new Set(hosts)];
}

/**
 * Reports each host written to a refusal log, once, as the log grows. The returned function looks a
 * last time and stops; call it before the log is removed.
 */
export function watchRefusals(
  file: string,
  onHost: (host: string) => void,
  clock: Clock = systemClock,
): () => void {
  let offset = 0;
  /** The end of a line the writer had not finished. */
  let partial = '';
  const told = new Set<string>();
  let stopped = false;

  function drain(): void {
    let fd: number;
    try {
      fd = openSync(file, 'r');
    } catch {
      return;
    }
    try {
      const size = fstatSync(fd).size;
      if (size <= offset) return;
      const buffer = Buffer.alloc(Math.min(size - offset, 64 * 1024));
      const read = readSync(fd, buffer, 0, buffer.length, offset);
      offset += read;
      const text = partial + buffer.toString('utf8', 0, read);
      const end = text.lastIndexOf('\n');
      partial = text.slice(end + 1);
      for (const host of readRefusedHosts(text.slice(0, end + 1))) {
        if (told.has(host) || told.size >= MAX_HOSTS) continue;
        told.add(host);
        onHost(host);
      }
    } catch {
      // A log that cannot be read says nothing more.
    } finally {
      closeSync(fd);
    }
  }

  // A poll, not a file watch: the log is small and is written rarely, and FSEvents is not always there.
  let timer: Timer | null = null;
  const schedule = (): void => {
    timer = clock.setTimeout(() => {
      drain();
      if (!stopped) schedule();
    }, POLL_MS);
  };
  schedule();
  return () => {
    if (stopped) return;
    stopped = true;
    timer?.cancel();
    drain();
  };
}
