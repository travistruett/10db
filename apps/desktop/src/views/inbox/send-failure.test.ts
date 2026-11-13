import { describe, expect, it } from 'vitest';
import { sendFailureWords } from './send-failure';

describe('sendFailureWords', () => {
  it.each([
    [
      'channel_not_found',
      'Mark',
      'Slack refused: channel_not_found. Mark may have left the workspace.',
    ],
    [
      'user_not_found',
      'Mark and Ana',
      'Slack refused: user_not_found. Mark and Ana may have left the workspace.',
    ],
    [
      'invalid_auth',
      'Mark',
      "Slack refused: invalid_auth. 10db's Slack token no longer works. Reconnect it in Settings › Integrations.",
    ],
    ['some_new_code', 'Mark', 'Slack refused: some_new_code.'],
    ['Slack refused: channel_not_found.', 'Mark', 'Slack refused: channel_not_found.'],
    [null, 'Mark', 'Slack did not take the message.'],
  ])('%s', (error, who, words) => {
    expect(sendFailureWords(error, who)).toBe(words);
  });
});
