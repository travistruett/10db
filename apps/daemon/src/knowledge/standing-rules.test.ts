import { describe, expect, it } from 'vitest';
import { standingRules } from './standing-rules';

describe('standingRules', () => {
  it.each([
    { name: 'no rule', text: 'Use teal.', rules: [] },
    {
      name: 'one never and one always',
      text: 'Use teal. Never use red for success states. Always run axe.',
      rules: ['Never use red for success states.', 'Always run axe.'],
    },
    {
      name: 'the sentence from the acceptance example',
      text: 'Use pg-boss. Also, always run the formatter before committing.',
      rules: ['Also, always run the formatter before committing.'],
    },
    { name: 'a word that only contains never', text: 'Nevertheless, use teal for now.', rules: [] },
    { name: 'a rule too short to state anything', text: 'Never.', rules: [] },
    {
      name: 'capitals',
      text: 'ALWAYS squash merge pull requests',
      rules: ['ALWAYS squash merge pull requests'],
    },
    {
      name: 'a list item on its own line',
      text: 'Teal.\n- never ship on Fridays',
      rules: ['never ship on Fridays'],
    },
    {
      name: 'more than three',
      text: 'Always do A now. Always do B now. Always do C now. Always do D now.',
      rules: ['Always do A now.', 'Always do B now.', 'Always do C now.'],
    },
    { name: 'empty', text: '', rules: [] },
  ])('$name', ({ text, rules }) => {
    expect(standingRules(text)).toEqual(rules);
  });
});
