import { describe, expect, it } from 'vitest';
import { goAheadText } from './go-ahead';

describe('goAheadText', () => {
  it('a command is fenced and named', () => {
    expect(goAheadText({ toolName: 'Bash', summary: 'npx vercel deploy --prod --yes' })).toBe(
      'I approve this exact Bash call. Run it again as it was:\n\n```\nnpx vercel deploy --prod --yes\n```',
    );
  });

  it('a command holding three backticks gets a four-backtick fence', () => {
    const summary = 'echo ```x```';
    expect(goAheadText({ toolName: 'Bash', summary })).toBe(
      `I approve this exact Bash call. Run it again as it was:\n\n\`\`\`\`\n${summary}\n\`\`\`\``,
    );
  });
});
