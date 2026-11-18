import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Provider } from '@10db/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { countSpawns, keepTranscripts } from './transcripts';

const use = (name: string): string =>
  JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 'x', name, input: {} }] },
  });

describe('countSpawns', () => {
  const rows = [
    {
      name: 'no tool calls',
      text: JSON.stringify({ type: 'user', message: { content: 'hi' } }),
      spawns: 0,
    },
    { name: 'an Agent call', text: use('Agent'), spawns: 1 },
    { name: 'a Task call, as older Claude Code names it', text: use('Task'), spawns: 1 },
    { name: 'other tools', text: [use('Read'), use('Bash')].join('\n'), spawns: 0 },
    {
      name: 'a line that is not JSON is skipped',
      text: ['{oops', use('Agent'), ''].join('\n'),
      spawns: 1,
    },
  ];
  it.each(rows)('$name', ({ text, spawns }) => {
    expect(countSpawns(text)).toBe(spawns);
  });
});

describe('keepTranscripts', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const temp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-transcripts-'));
    dirs.push(dir);
    return dir;
  };

  it('copies each session transcript and its subagents, and names the ones it found none for', () => {
    const configDir = temp();
    const into = temp();
    const project = join(configDir, 'projects', '-private-tmp-repo');
    mkdirSync(join(project, 'psid-1', 'subagents'), { recursive: true });
    writeFileSync(join(project, 'psid-1.jsonl'), `${use('Agent')}\n`);
    writeFileSync(join(project, 'psid-1', 'subagents', 'agent-a.jsonl'), `${use('Read')}\n`);

    const kept = keepTranscripts(
      [
        { sessionId: 'ses_a', provider: Provider.Claude, providerSessionId: 'psid-1', configDir },
        {
          sessionId: 'ses_b',
          provider: Provider.Claude,
          providerSessionId: 'psid-gone',
          configDir,
        },
        { sessionId: 'ses_c', provider: Provider.Claude, providerSessionId: null, configDir },
        { sessionId: 'ses_d', provider: Provider.Codex, providerSessionId: 'thread', configDir },
      ],
      into,
    );

    expect(kept.kept).toEqual([{ sessionId: 'ses_a', spawns: 1 }]);
    expect(kept.missing).toEqual(['ses_b', 'ses_c']);
    expect(kept.unsupported).toEqual(['ses_d']);
    expect(readFileSync(join(into, 'ses_a.jsonl'), 'utf8')).toContain('Agent');
    expect(existsSync(join(into, 'ses_a', 'subagents', 'agent-a.jsonl'))).toBe(true);
  });
});
