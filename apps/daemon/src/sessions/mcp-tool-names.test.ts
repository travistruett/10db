import { describe, expect, it } from 'vitest';
import { currentToolNames, mcpStatusToolNames } from './mcp-tool-names';

describe('mcpStatusToolNames', () => {
  it.each<[string, Parameters<typeof mcpStatusToolNames>[0], string[]]>([
    [
      'a connected server lists its tools in full form',
      [{ name: 'aws-billing', status: 'connected', tools: [{ name: 'credits' }] }],
      ['mcp__aws-billing__credits'],
    ],
    [
      'a name outside [A-Za-z0-9_-] is written as Claude Code writes it',
      [{ name: 'my server', status: 'connected', tools: [{ name: 'go' }] }],
      ['mcp__my_server__go'],
    ],
    [
      'a name already in full form is kept',
      [{ name: 's', status: 'connected', tools: [{ name: 'mcp__s__t' }] }],
      ['mcp__s__t'],
    ],
    [
      'a server that is not connected lists none',
      [{ name: 's', status: 'pending', tools: [{ name: 't' }] }],
      [],
    ],
    ['a connected server with no tool list lists none', [{ name: 's', status: 'connected' }], []],
  ])('%s', (_name, servers, expected) => {
    expect(mcpStatusToolNames(servers)).toEqual(expected);
  });
});

describe('currentToolNames', () => {
  it('joins what init listed with what the connected servers list, once each', async () => {
    const errors: unknown[] = [];
    const names = await currentToolNames(
      () =>
        Promise.resolve([
          { name: 's', status: 'connected', tools: [{ name: 'a' }, { name: 'b' }] },
        ]),
      ['Bash', 'mcp__s__a'],
      (error) => errors.push(error),
    );
    expect(names).toEqual(['Bash', 'mcp__s__a', 'mcp__s__b']);
    expect(errors).toEqual([]);
  });

  it('falls back to what init listed, and reports why, when the status call fails', async () => {
    const errors: unknown[] = [];
    const names = await currentToolNames(
      () => Promise.reject(new Error('gone')),
      ['Bash'],
      (error) => errors.push(error),
    );
    expect(names).toEqual(['Bash']);
    expect(errors).toHaveLength(1);
  });
});
