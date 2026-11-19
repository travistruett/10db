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
  it('names the tool and fences the exact call, with a longer fence than any it holds', () => {
    const summary = 'echo ```x```';
    const rows: [string, DeniedCall, string][] = [
      [
        'a command',
        denied(),
        'I approve this exact Bash call. Run it again as it was:\n\n```\nnpx vercel deploy --prod --yes\n```',
      ],
      [
        'a command holding three backticks',
        denied({ summary }),
        `I approve this exact Bash call. Run it again as it was:\n\n\`\`\`\`\n${summary}\n\`\`\`\``,
      ],
      [
        'a WebFetch',
        denied({ toolName: 'WebFetch', summary: 'https://example.com/a?b=1' }),
        'I approve this exact WebFetch call. Run it again as it was:\n\n```\nhttps://example.com/a?b=1\n```',
      ],
    ];
    for (const [name, call, text] of rows) expect.soft(goAheadText(call), name).toBe(text);
  });
});

describe('deniedNoticeText', () => {
  const head =
    'Auto mode stopped this Bash call:\n\n```\nnpx vercel deploy --prod --yes\n```\n\nIts reason: The classifier judged this action dangerous';

  it('ends at the reason, or says what Allow this or a safety check means', () => {
    const rows: [string, DeniedCall, boolean, string][] = [
      [
        'the notice with Allow this says a second refusal is a hard line',
        denied(),
        true,
        `${head}\n\nAllow this sends your go-ahead. If auto mode refuses it again, it is a line Claude Code holds whatever you say.`,
      ],
      ['a notice that offers nothing ends at the reason', denied(), false, head],
      [
        "a safety check's notice says only the builder can run it",
        denied({ by: 'safety_check' }),
        false,
        `${head}\n\nThis is one of Claude Code's own safety checks; only you can run it, in a terminal.`,
      ],
    ];
    for (const [name, call, offers, text] of rows) {
      expect.soft(deniedNoticeText(call, offers), name).toBe(text);
    }
    // A 4001-character command shows its first 4000 characters and (cut), with no Allow this.
    const notice = deniedNoticeText(
      denied({ summary: 'a'.repeat(ALLOW_THIS_MAX_CHARS + 1) }),
      false,
    );
    expect
      .soft(notice, 'a 4001-character command')
      .toBe(
        `Auto mode stopped this Bash call:\n\n\`\`\`\n${'a'.repeat(ALLOW_THIS_MAX_CHARS)} (cut)\n\`\`\`\n\nIts reason: The classifier judged this action dangerous`,
      );
    expect.soft(notice, 'a 4001-character command').not.toContain('Allow this');
  });
});
