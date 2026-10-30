import { describe, expect, it } from 'vitest';
import { BlockedRun, blockedHostsNote, createBlockedHostFilter } from './blocked-hosts';

/** Feeds `lines` (each ended with a newline) through a filter; answers what it kept and the hosts. */
function filter(lines: readonly string[], options?: { readonly commandLines?: number }) {
  const f = createBlockedHostFilter(options);
  const kept = lines.map((line) => f.push(`${line}\n`)).join('') + f.end();
  return { kept, blocked: f.blocked() };
}

describe('the filter over a sandboxed gate’s stderr', () => {
  it('reads the host from a CONNECT that srt refused', () => {
    expect(filter(['[SandboxDebug] Connection blocked to Index.Crates.io:443']).blocked).toEqual([
      'index.crates.io',
    ]);
  });

  it('reads the host from a plain HTTP request that srt refused', () => {
    const { kept, blocked } = filter([
      '[SandboxDebug] HTTP request blocked to example.com:80',
      'curl: (22) The requested URL returned error: 403',
    ]);
    expect(blocked).toEqual(['example.com']);
    expect(kept).toBe('curl: (22) The requested URL returned error: 403\n');
  });

  it('finds the debug line after output the command left without a newline, and keeps that output', () => {
    const { kept, blocked } = filter([
      '\r  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0[SandboxDebug] Connection blocked to h.example.com:443',
      'curl: (56) CONNECT tunnel failed, response 403',
    ]);
    expect(blocked).toEqual(['h.example.com']);
    expect(kept).toBe(
      '\r  0     0    0     0    0     0      0      0 --:--:-- --:--:-- --:--:--     0\ncurl: (56) CONNECT tunnel failed, response 403\n',
    );
    expect(kept).not.toContain('SandboxDebug');
  });

  it('keeps the command’s indented lines that follow a one-line debug message', () => {
    const { kept } = filter([
      '[SandboxDebug] Allowed by config rule: index.crates.io:443',
      '  Downloaded serde v1.0.0',
      '[SandboxDebug] Connection allowed to static.crates.io:443',
      '   Compiling serde v1.0.0',
      '{ "json": "the command printed" }',
      '    error[E0425]: cannot find value',
    ]);
    expect(kept).toBe(
      [
        '  Downloaded serde v1.0.0',
        '   Compiling serde v1.0.0',
        '{ "json": "the command printed" }',
        '    error[E0425]: cannot find value',
        '',
      ].join('\n'),
    );
  });

  it('drops a debug message that opens a block, up to its closing line, and nothing after it', () => {
    const { kept } = filter([
      '[SandboxDebug] {',
      '  "allowedDomains": [',
      '    "registry.npmjs.org"',
      '  ]',
      '}',
      '  indented output of the command',
    ]);
    expect(kept).toBe('  indented output of the command\n');
  });

  it('drops every line of the command srt echoes, which holds the project env', () => {
    const { kept } = filter(
      [
        "[SandboxDebug] Command string mode (-c): trap 'exit 143' TERM; /usr/bin/env TOKEN='hunter2' /bin/sh -c 'cargo build",
        '  cargo test --workspace',
        "  cargo doc' ; exit $?",
        '  indented output of the command',
      ],
      { commandLines: 3 },
    );
    expect(kept).toBe('  indented output of the command\n');
  });

  it('reads a line split across chunks', () => {
    const f = createBlockedHostFilter();
    expect(f.push('[SandboxDebug] Connection blo')).toBe('');
    expect(f.push('cked to a.example.com:443\nok\n')).toBe('ok\n');
    expect(f.blocked()).toEqual(['a.example.com']);
  });
});

/** A pipe's chunk: stderr arrives this many characters at a time. */
const CHUNK = 'x'.repeat(64 * 1024);
const MIB = 1024 * 1024;

describe('the filter over a long line with no newline', () => {
  // The filter runs on the daemon's only thread, and the gate's command is the lane's code.
  it('takes time linear in the line, not in the line times the chunks', () => {
    const f = createBlockedHostFilter();
    const started = performance.now();
    for (let i = 0; i < (32 * MIB) / CHUNK.length; i += 1) f.push(CHUNK);
    f.end();
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('passes the command’s text on as it comes rather than holding the whole line', () => {
    const f = createBlockedHostFilter();
    let kept = 0;
    for (let i = 0; i < (8 * MIB) / CHUNK.length; i += 1) kept += f.push(CHUNK).length;
    expect(kept).toBeGreaterThan(4 * MIB);
    expect(kept + f.end().length).toBe(8 * MIB);
  });

  it('never splits a character between what it passes on and what it holds back', () => {
    const f = createBlockedHostFilter();
    // An emoji is two UTF-16 units; here it straddles where the filter cuts the held line.
    const line = `${'x'.repeat(3 * MIB - 14)}😀${'x'.repeat(12)}`;
    const passed = f.push(line);
    expect(passed.length).toBeGreaterThan(0);
    expect(/[\uD800-\uDBFF]$/.test(passed)).toBe(false);
    expect(passed + f.end() === line).toBe(true);
  });

  it('still reads and drops a debug message that ends the long line', () => {
    const f = createBlockedHostFilter();
    let kept = '';
    for (let i = 0; i < (3 * MIB) / CHUNK.length; i += 1) kept += f.push(CHUNK);
    kept += f.push('[SandboxDebug] Connection blocked to h.example.com:443\nnext\n') + f.end();
    expect(f.blocked()).toEqual(['h.example.com']);
    expect(kept).toBe(`${'x'.repeat(3 * MIB)}\nnext\n`);
  });

  it('drops a long echoed command line whole, however many chunks it comes in', () => {
    const f = createBlockedHostFilter();
    const echo = `[SandboxDebug] Command string mode (-c): /usr/bin/env TOKEN='hunter2' ${'x'.repeat(MIB)}\n`;
    let kept = '';
    for (let at = 0; at < echo.length; at += CHUNK.length) {
      kept += f.push(echo.slice(at, at + CHUNK.length));
    }
    kept += f.push('ok\n') + f.end();
    expect(kept).toBe('ok\n');
  });
});

describe('what the gate’s evidence says about blocked hosts', () => {
  it('says nothing when nothing was blocked', () => {
    expect(blockedHostsNote([], BlockedRun.Gate)).toBe('');
  });

  it('points a host the project may be given at the Inbox and Settings', () => {
    const note = blockedHostsNote(['index.crates.io', 'static.crates.io'], BlockedRun.Gate);
    expect(note).toContain(
      "The gate was blocked from reaching index.crates.io and static.crates.io: they are not among the project's allowed network hosts.",
    );
    expect(note).toContain('Settings › Network hosts');
    expect(note).toContain('then run the gate again.');
  });

  it('says a host that can’t be allowed can’t be, and sends nobody to a card for it', () => {
    const note = blockedHostsNote(['db', '*.example.com'], BlockedRun.Gate);
    expect(note).toContain('The gate was blocked from reaching db and *.example.com');
    expect(note).toContain("can't be allowed as network hosts");
    expect(note).not.toContain('Inbox');
  });

  it('words each case for itself when both appear', () => {
    const note = blockedHostsNote(['index.crates.io', 'intranet'], BlockedRun.Gate);
    expect(note).toContain("index.crates.io: it is not among the project's allowed network hosts");
    expect(note).toContain("intranet: it can't be allowed as a network host");
  });

  it('says the install was blocked, and never the gate, when 10db’s install of a worktree’s packages was', () => {
    for (const hosts of [['registry.npmjs.org'], ['db']]) {
      const note = blockedHostsNote(hosts, BlockedRun.Install);
      expect(note).toContain(`The install was blocked from reaching ${hosts.join('')}`);
      expect(note).not.toMatch(/\bgate\b/i);
    }
    expect(blockedHostsNote(['registry.npmjs.org'], BlockedRun.Install)).toContain(
      'Allow it for the project, from the Inbox or in Settings › Network hosts, then try again.',
    );
  });
});
