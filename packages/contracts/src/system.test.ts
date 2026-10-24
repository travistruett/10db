import { describe, expect, it } from 'vitest';
import { SystemCheckDto } from './index';

describe('SystemCheckDto', () => {
  it('accepts a report with a missing optional tool', () => {
    const report = {
      loginEnv: { source: 'login_shell', warning: null },
      claudeCode: { verifiedOn: '2.1.302', warning: null },
      tools: [
        {
          name: 'claude',
          path: '/h/b/.local/bin/claude',
          version: '2.1.299 (Claude Code)',
          required: true,
        },
        { name: 'docker', path: null, version: null, required: false },
      ],
    };
    expect(SystemCheckDto.parse(report)).toEqual(report);
  });

  it('rejects an unknown tool name', () => {
    expect(
      SystemCheckDto.safeParse({
        loginEnv: { source: 'inherited', warning: 'x' },
        claudeCode: { verifiedOn: '2.1.302', warning: null },
        tools: [{ name: 'node', path: null, version: null, required: true }],
      }).success,
    ).toBe(false);
  });
});
