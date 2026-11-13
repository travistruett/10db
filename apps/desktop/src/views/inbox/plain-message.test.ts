import { describe, expect, it } from 'vitest';
import { plainMessage } from './plain-message';

describe('plainMessage', () => {
  it.each([
    [
      'speaks as the builder whatever name the Slack text used',
      "You's 10db build of *Renewals* has a question for you.",
      'My 10db build of Renewals has a question for you.',
    ],
    [
      'speaks as the builder when the name is real',
      "Travis's 10db build of *Renewals* has a question for you.",
      'My 10db build of Renewals has a question for you.',
    ],
    [
      'drops bold and italic markers',
      '*How long?*\n*A.* Seven days  _(recommended)_\n*B.* Never',
      'How long?\nA. Seven days  (recommended)\nB. Never',
    ],
    ['undoes Slack escapes', 'a &amp; b &lt;c&gt; &amp;lt;', 'a & b <c> &lt;'],
    ['keeps underscores inside words', 'snake_case_name and *bold*', 'snake_case_name and bold'],
    ['leaves a message that is already plain alone', 'Hello there.', 'Hello there.'],
  ])('%s', (_name, slack, plain) => {
    expect(plainMessage(slack)).toBe(plain);
  });
});
