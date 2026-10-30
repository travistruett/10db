import { describe, expect, it } from 'vitest';
import { blockedHostsNote, createBlockedHostFilter } from './blocked-hosts';

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

describe('what the gate’s evidence says about blocked hosts', () => {
  it('says nothing when nothing was blocked', () => {
    expect(blockedHostsNote([])).toBe('');
  });

  it('points a host the project may be given at the Inbox and Settings', () => {
    const note = blockedHostsNote(['index.crates.io', 'static.crates.io']);
    expect(note).toContain(
      "The gate was blocked from reaching index.crates.io and static.crates.io: they are not among the project's allowed network hosts.",
    );
    expect(note).toContain('Settings › Network hosts');
  });

  it('says a host that can’t be allowed can’t be, and sends nobody to a card for it', () => {
    const note = blockedHostsNote(['db', '*.example.com']);
    expect(note).toContain('The gate was blocked from reaching db and *.example.com');
    expect(note).toContain("can't be allowed as network hosts");
    expect(note).not.toContain('Inbox');
  });

  it('words each case for itself when both appear', () => {
    const note = blockedHostsNote(['index.crates.io', 'intranet']);
    expect(note).toContain("index.crates.io: it is not among the project's allowed network hosts");
    expect(note).toContain("intranet: it can't be allowed as a network host");
  });
});
