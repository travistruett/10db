import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { loadEnv } from '../src/env';
import {
  addAccount,
  addProject,
  localClaude,
  openChat,
  sendAndWait,
  startLiveDaemon,
  until,
  waitForPinnedCodex,
  type LiveDaemon,
} from './live-chat-daemon';

/**
 * Open in Terminal on the real daemon, with Copy the Command so no window opens on the builder's screen: the line
 * the daemon answers runs under a pty this test spawns, and the agent's TUI is read for what it shows first.
 * Manual, never CI:
 *   TENDB_LIVE_CLAUDE=1 pnpm --filter @10db/daemon exec vitest run test/takeover.live.test.ts
 *   TENDB_LIVE_CODEX=1 pnpm --filter @10db/daemon exec vitest run test/takeover.live.test.ts
 * What needs a Terminal or iTerm window, or the builder's eyes on the TUI, is not here: the research record's "M7 live
 * checks" lists it. Each observation is also appended to `TENDB_LIVE_REPORT` when set.
 */
const liveEnv = loadEnv(process.env);
const claudeLive = liveEnv.TENDB_LIVE_CLAUDE === '1';
const codexLive = liveEnv.TENDB_LIVE_CODEX === '1';

function note(text: string): void {
  console.info(text);
  const file = liveEnv.TENDB_LIVE_REPORT;
  if (file !== undefined) appendFileSync(file, `${text}\n`);
}

/** What a terminal drew, without its colour and cursor codes. */
const plain = (text: string): string =>
  text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g'), '');

const Taken = z.object({ line: z.string().nullable(), notes: z.array(z.string()) });

/**
 * Runs in a pty of its own: the line, for `ms`. Python's `pty` is used because macOS `script` needs a terminal on
 * its own stdin.
 */
const PTY_RUNNER = `
import fcntl, json, os, pty, select, signal, struct, subprocess, sys, termios, time
line, ms = sys.argv[1], float(sys.argv[2])
pid, fd = pty.fork()
if pid == 0:
    os.execv('/bin/sh', ['/bin/sh', '-c', line])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
out = b''
end = time.time() + ms / 1000
while time.time() < end:
    ready, _, _ = select.select([fd], [], [], 0.5)
    if ready:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        out += data
alive = os.waitpid(pid, os.WNOHANG) == (0, 0)
ps = subprocess.run(['/bin/ps', '-axo', 'command='], capture_output=True, text=True).stdout
try:
    os.killpg(os.getpgid(pid), signal.SIGTERM)
except OSError:
    pass
print(json.dumps({'screen': out.decode('utf8', 'replace'), 'ps': ps, 'alive': alive}))
`;

const Drawn = z.object({ screen: z.string(), ps: z.string(), alive: z.boolean() });

/** Runs `line` in a pty for `ms`, answers what the terminal drew, and the command lines of every process. */
async function drawn(line: string, ms: number): Promise<z.infer<typeof Drawn>> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      '/usr/bin/python3',
      ['-I', '-c', PTY_RUNNER, line, String(ms)],
      { maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error === null) resolve(stdout);
        else reject(new Error(error.message, { cause: error }));
      },
    );
  });
  return Drawn.parse(JSON.parse(output));
}

/** A chat that has said one thing, taken to a copied command; hands back at the end. */
async function takenOver(
  daemon: LiveDaemon,
  accountId: string | null,
): Promise<{ line: string; notes: string[]; handBack: () => Promise<void> }> {
  const project = await addProject(daemon, accountId);
  const chat = await openChat(daemon, project.id, null);
  await sendAndWait(daemon, chat.conversationId, 'Say the word ready.', 'wait');
  await daemon.api(z.looseObject({}), '/settings/sessions', {
    method: 'PATCH',
    body: { terminalApp: 'copy' },
  });
  const taken = await daemon.api(Taken, `/conversations/${chat.conversationId}/takeover`, {
    method: 'POST',
  });
  if (taken.line === null) throw new Error('Copy the Command answered no line');
  return {
    line: taken.line,
    notes: taken.notes,
    handBack: async () => {
      await daemon.api(z.undefined(), `/conversations/${chat.conversationId}/hand-back`, {
        method: 'POST',
      });
    },
  };
}

describe.skipIf(!claudeLive)('Open in Terminal, live, Claude plan (LC1, pty only)', () => {
  it('starts the TUI with no first-run screen, leaves its script until Hand Back, and hands back', async () => {
    const daemon = await startLiveDaemon('lc1-takeover', { claudePath: localClaude() });
    try {
      const taken = await takenOver(daemon, null);
      note(`LC1 notes: ${JSON.stringify(taken.notes)}`);
      const run = await drawn(taken.line, 25_000);
      note(`LC1 TUI alive after 25 s: ${String(run.alive)}`);
      const screen = plain(run.screen);
      note(`LC1 first screen: ${JSON.stringify(screen.slice(0, 600))}`);
      expect(run.alive).toBe(true);
      // An account with a directory of its own has its first-run and folder-trust marks written; the builder's
      // own default account keeps them in their own `~/.claude.json`, which 10db never edits, so a folder
      // they have not trusted asks once. The result says which one this run was.
      const squeezed = screen.replaceAll(/\s+/g, '').toLowerCase();
      note(`LC1 trust question shown: ${String(squeezed.includes('quicksafetycheck'))}`);
      expect(screen).not.toMatch(/Choose the text style|Welcome to Claude Code/i);
      expect(run.ps).not.toMatch(/sk-ant-|AWS_BEARER_TOKEN_BEDROCK=/);
      const folder = join(daemon.work.path, 'data', 'takeovers');
      const leftover = existsSync(folder)
        ? readdirSync(folder).flatMap((id) =>
            readdirSync(join(folder, id)).filter((name) => name.endsWith('.command')),
          )
        : [];
      // The line never runs the script file, so the file stays until Hand Back removes it.
      note(`LC1 script files before Hand Back: ${String(leftover.length)}`);
      await taken.handBack();
      expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([]);
      note('LC1 takeover folder after Hand Back: empty');
    } finally {
      await daemon.stop();
    }
  }, 600_000);
});

describe.skipIf(!codexLive)('Open in Terminal, live, ChatGPT plan (LC4, pty only)', () => {
  it('starts the TUI and passes no header token to a command', async () => {
    const daemon = await startLiveDaemon('lc4-takeover');
    try {
      await waitForPinnedCodex(daemon);
      const account = await addAccount(daemon, {
        kind: 'codex_signin',
        label: 'ChatGPT plan live check',
      });
      const connect = await daemon.api(
        z.object({ authUrl: z.string().nullable() }),
        `/accounts/${account.id}/connect`,
        { method: 'POST' },
      );
      note(`LC4 sign in at: ${connect.authUrl ?? '(the browser opened by itself)'}`);
      await until('the ChatGPT sign-in to finish', 600_000, () =>
        account.configDir !== null && existsSync(join(account.configDir, 'auth.json'))
          ? true
          : null,
      );
      const taken = await takenOver(daemon, account.id);
      note(`LC4 notes: ${JSON.stringify(taken.notes)}`);
      const run = await drawn(taken.line, 25_000);
      const screen = plain(run.screen);
      note(`LC4 first screen: ${JSON.stringify(screen.slice(0, 600))}`);
      expect(run.alive).toBe(true);
      expect(run.ps).not.toMatch(/TENDB_MCP_TOKEN_[0-9]+_[0-9]+=/);
      await taken.handBack();
    } finally {
      await daemon.stop();
    }
  }, 1_200_000);
});
