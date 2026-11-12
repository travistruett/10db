import { describe, expect, it } from 'vitest';
import {
  broughtInLine,
  couldntAddLine,
  fullLine,
  movedLine,
  proposalLine,
  replyWithLine,
  reminderLine,
  whichWayLine,
} from './index';

describe('fixed lines', () => {
  it.each([
    [
      'brought in one person',
      broughtInLine('Mark', ['Priya']),
      "Mark brought in Priya. Here's the question:",
    ],
    [
      'brought in two',
      broughtInLine('Mark', ['Priya', 'Sam']),
      "Mark brought in Priya and Sam. Here's the question:",
    ],
    ['moved', movedLine(['Priya']), 'Moved to a group DM with Priya.'],
    ['moved with two', movedLine(['Priya', 'Sam']), 'Moved to a group DM with Priya and Sam.'],
    ['could not add', couldntAddLine('Priya'), "10db couldn't add Priya to this conversation."],
    ['full', fullLine(), "This conversation is full; 10db can't add anyone else."],
    ['reminder', reminderLine(), 'Bumping this: the work is still waiting on your answer.'],
    ['reply with, two options', replyWithLine(['A', 'B']), 'Reply with A, B, or your own words.'],
    ['reply with, one option', replyWithLine(['A']), 'Reply with A, or your own words.'],
    ['reply with, no options', replyWithLine([]), 'Reply with your own words.'],
  ])('%s', (_name, actual, expected) => {
    expect(actual).toBe(expected);
  });
});

describe('proposalLine', () => {
  it('names the choice, who favoured it, and tags the recipient by id', () => {
    expect(proposalLine('B', 'Cut access at once', ['Priya'], ['UMARK'])).toBe(
      'Sounds like *B*: Cut access at once (Priya). <@UMARK>, ✅ to approve or reply to change.',
    );
  });

  it('leaves the parentheses out when nobody is named', () => {
    expect(proposalLine('B', 'Cut access at once', [], ['UMARK'])).toBe(
      'Sounds like *B*: Cut access at once. <@UMARK>, ✅ to approve or reply to change.',
    );
  });

  it('tags every recipient and lists several favouring names', () => {
    expect(proposalLine('C', 'Whole period', ['Priya', 'Sam'], ['UMARK', 'UANA'])).toBe(
      'Sounds like *C*: Whole period (Priya and Sam). <@UMARK> <@UANA>, ✅ to approve or reply to change.',
    );
  });

  it('escapes names and labels, and builds mentions only from ids', () => {
    const line = proposalLine('B', '<!channel> go', ['<@UEVIL>'], ['UMARK', '<!channel>', 'U1|x']);
    expect(line).toBe(
      'Sounds like *B*: &lt;!channel&gt; go (&lt;@UEVIL&gt;). <@UMARK>, ✅ to approve or reply to change.',
    );
  });
});

describe('whichWayLine', () => {
  it.each([
    [
      ['A', 'B'],
      ['UMARK'],
      '<@UMARK>, which way should this go? Reply with A or B, or in your own words.',
    ],
    [
      ['A', 'B', 'C'],
      ['UMARK'],
      '<@UMARK>, which way should this go? Reply with A, B or C, or in your own words.',
    ],
    [
      ['A', 'B', 'C'],
      ['UMARK', 'UANA'],
      '<@UMARK> <@UANA>, which way should this go? Reply with A, B or C, or in your own words.',
    ],
  ])('%j for %j', (letters, ids, expected) => {
    expect(whichWayLine(letters, ids)).toBe(expected);
  });

  it('drops anything that is not a user id', () => {
    expect(whichWayLine(['A', 'B'], ['UMARK', 'here', '<!channel>'])).toBe(
      '<@UMARK>, which way should this go? Reply with A or B, or in your own words.',
    );
  });
});
