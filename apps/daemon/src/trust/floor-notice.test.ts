import { AccountKind, requireHarness, type SupportedAccountKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { FloorReason, floorNoticeText, floorReason } from './floor-notice';

describe('floorReason', () => {
  it("falls to 10db's rules when the setting is off, or when neither auto mode nor a ready judge runs", () => {
    const rows: [
      string,
      SupportedAccountKind,
      string | null,
      boolean,
      boolean,
      FloorReason | null,
    ][] = [
      [
        'a plan on a supported model, setting on',
        AccountKind.ClaudeSubscription,
        'sonnet',
        true,
        false,
        null,
      ],
      [
        'a plan on a supported model, setting off',
        AccountKind.ClaudeSubscription,
        'sonnet',
        false,
        true,
        FloorReason.Setting,
      ],
      [
        'a plan on an old model with a ready judge',
        AccountKind.ClaudeSubscription,
        'claude-sonnet-4-5',
        true,
        true,
        null,
      ],
      [
        'a plan on an old model without one',
        AccountKind.ClaudeSubscription,
        'claude-sonnet-4-5',
        true,
        false,
        FloorReason.NoJudge,
      ],
      [
        'a plan on an old model, setting off',
        AccountKind.ClaudeSubscription,
        'claude-sonnet-4-5',
        false,
        true,
        FloorReason.Setting,
      ],
      [
        'an API key on an unreadable id without a judge',
        AccountKind.AnthropicApiKey,
        'my-model',
        true,
        false,
        FloorReason.NoJudge,
      ],
      [
        'Bedrock with no model pin and no judge',
        AccountKind.Bedrock,
        null,
        true,
        false,
        FloorReason.NoJudge,
      ],
      [
        'Bedrock on a supported model without a judge',
        AccountKind.Bedrock,
        'us.anthropic.claude-sonnet-5-5-v1:0',
        true,
        false,
        null,
      ],
      ['a gateway kind with a ready judge', AccountKind.Gateway, 'sonnet', true, true, null],
      [
        'a gateway kind without one',
        AccountKind.Gateway,
        'sonnet',
        true,
        false,
        FloorReason.NoJudge,
      ],
      [
        'a gateway kind, setting off',
        AccountKind.Gateway,
        'sonnet',
        false,
        true,
        FloorReason.Setting,
      ],
      ['Codex with a ready judge', AccountKind.CodexSignin, 'gpt-5.5', true, true, null],
      ['Codex without one', AccountKind.CodexSignin, 'gpt-5.5', true, false, FloorReason.NoJudge],
      ['Codex, setting off', AccountKind.CodexSignin, 'gpt-5.5', false, true, FloorReason.Setting],
    ];
    for (const [name, kind, model, autoMode, tendbReady, expected] of rows) {
      expect
        .soft(
          floorReason({
            kind,
            harness: requireHarness({ kind, label: name, settings: {} }),
            model,
            autoMode,
            tendbReady,
          }),
          name,
        )
        .toBe(expected);
    }
  });
});

describe('floorNoticeText', () => {
  it('says why the rules judge the session', () => {
    const rows: [string, FloorReason, boolean, string][] = [
      [
        'the setting',
        FloorReason.Setting,
        true,
        `10db's rules judge this session, not auto mode: "Lanes decide routine permissions" is off in Settings. A call those rules can't settle waits on a card.`,
      ],
      [
        'no judge, attended',
        FloorReason.NoJudge,
        true,
        "10db's rules judge this session: 10db's judge needs an OpenRouter key and its Limits switch on in Settings › Decisions. A call those rules can't settle waits on a card.",
      ],
      [
        'no judge, in a lane',
        FloorReason.NoJudge,
        false,
        "10db's rules judge this session: 10db's judge needs an OpenRouter key and its Limits switch on in Settings › Decisions. A call those rules can't settle is skipped, not asked about.",
      ],
      [
        'the judge unavailable',
        FloorReason.JudgeUnavailable,
        false,
        "10db's judge didn't answer (No answer within 4 s), so 10db's rules judge calls until it answers again.",
      ],
      [
        'left auto mode',
        FloorReason.LeftAutoMode,
        true,
        "Claude Code stopped running in auto mode during this session, so 10db's rules judge its calls from here. A call those rules can't settle waits on a card.",
      ],
    ];
    for (const [name, reason, attended, text] of rows) {
      expect
        .soft(floorNoticeText(reason, { attended, detail: 'No answer within 4 s' }), name)
        .toBe(text);
    }
  });
});
