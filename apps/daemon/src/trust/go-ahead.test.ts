import { describe, expect, it } from 'vitest';
import { ALLOW_THIS_MAX_CHARS, deniedNoticeText, goAheadText, type DeniedCall } from './go-ahead';

const denied = (overrides: Partial<DeniedCall> = {}): DeniedCall => ({
  toolUseId: 't1',
  toolName: 'Bash',
  summary: 'npx vercel deploy --prod --yes',
  reason: 'The classifier judged this action dangerous',
  by: 'classifier',
  limit: null,
  ...overrides,
});

describe('goAheadText', () => {
  it('a command is fenced and named', () => {
    expect(goAheadText(denied())).toBe(
      'I approve this exact Bash call. Run it again as it was:\n\n```\nnpx vercel deploy --prod --yes\n```',
    );
  });

  it('a command holding three backticks gets a four-backtick fence', () => {
    const summary = 'echo ```x```';
    expect(goAheadText(denied({ summary }))).toBe(
      `I approve this exact Bash call. Run it again as it was:\n\n\`\`\`\`\n${summary}\n\`\`\`\``,
    );
  });

  it('a WebFetch names its url', () => {
    expect(
      goAheadText(denied({ toolName: 'WebFetch', summary: 'https://example.com/a?b=1' })),
    ).toBe(
      'I approve this exact WebFetch call. Run it again as it was:\n\n```\nhttps://example.com/a?b=1\n```',
    );
  });
});

describe('deniedNoticeText', () => {
  const head =
    'Auto mode stopped this Bash call:\n\n```\nnpx vercel deploy --prod --yes\n```\n\nIts reason: The classifier judged this action dangerous';

  it('the notice with Allow this says a second refusal is a hard line', () => {
    expect(deniedNoticeText(denied(), true)).toBe(
      `${head}\n\nAllow this sends your go-ahead. If auto mode refuses it again, it is a line Claude Code holds whatever you say.`,
    );
  });

  it('a notice that offers nothing ends at the reason', () => {
    expect(deniedNoticeText(denied(), false)).toBe(head);
  });

  it("a safety check's notice says only the builder can run it", () => {
    expect(deniedNoticeText(denied({ by: 'safety_check' }), false)).toBe(
      `${head}\n\nThis is one of Claude Code's own safety checks; only you can run it, in a terminal.`,
    );
  });

  it('a 4001-character command shows its first 4000 characters and (cut), with no Allow this sentence', () => {
    const summary = 'a'.repeat(ALLOW_THIS_MAX_CHARS + 1);
    const notice = deniedNoticeText(denied({ summary }), false);
    expect(notice).toBe(
      `Auto mode stopped this Bash call:\n\n\`\`\`\n${'a'.repeat(ALLOW_THIS_MAX_CHARS)} (cut)\n\`\`\`\n\nIts reason: The classifier judged this action dangerous`,
    );
    expect(notice).not.toContain('Allow this');
  });
});
