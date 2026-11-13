import { AccountKind, type SupportedAccountKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { FloorReason, floorNoticeText, floorReason } from './floor-notice';

describe('floorReason', () => {
  it.each<[string, SupportedAccountKind, string | null, boolean, FloorReason | null]>([
    [
      'a plan on a supported model, setting on',
      AccountKind.ClaudeSubscription,
      'sonnet',
      true,
      null,
    ],
    [
      'a plan on a supported model, setting off',
      AccountKind.ClaudeSubscription,
      'sonnet',
      false,
      FloorReason.Setting,
    ],
    [
      'a plan on an old model, setting on',
      AccountKind.ClaudeSubscription,
      'claude-sonnet-4-5',
      true,
      FloorReason.Model,
    ],
    [
      'a plan on an old model, setting off',
      AccountKind.ClaudeSubscription,
      'claude-sonnet-4-5',
      false,
      FloorReason.Setting,
    ],
    [
      'an API key on a supported model, setting on',
      AccountKind.AnthropicApiKey,
      'claude-sonnet-5-5',
      true,
      null,
    ],
    [
      'an API key on an unreadable id, setting on',
      AccountKind.AnthropicApiKey,
      'my-model',
      true,
      FloorReason.Model,
    ],
    ['Bedrock with no model pin, setting on', AccountKind.Bedrock, null, true, FloorReason.Model],
    [
      'Bedrock on a supported model, setting on',
      AccountKind.Bedrock,
      'us.anthropic.claude-sonnet-5-5-v1:0',
      true,
      null,
    ],
    [
      'Bedrock on a supported model, setting off',
      AccountKind.Bedrock,
      'us.anthropic.claude-sonnet-5-5-v1:0',
      false,
      FloorReason.Setting,
    ],
    ['a gateway, setting on', AccountKind.Gateway, 'sonnet', true, FloorReason.Gateway],
    ['a gateway, setting off', AccountKind.Gateway, 'sonnet', false, FloorReason.Gateway],
    ['Codex, setting on', AccountKind.CodexSignin, 'gpt-5.5', true, FloorReason.Codex],
    ['Codex, setting off', AccountKind.CodexSignin, 'gpt-5.5', false, FloorReason.Codex],
  ])('%s', (_name, kind, model, autoMode, expected) => {
    expect(floorReason({ kind, model, autoMode })).toBe(expected);
  });
});

describe('floorNoticeText', () => {
  it('quotes the model of a model notice', () => {
    expect(floorNoticeText(FloorReason.Model, 'claude-sonnet-4-5')).toBe(
      "10db's rules judge this session, not auto mode: auto mode doesn't run on `claude-sonnet-4-5` on this account. A call those rules can't settle waits on a card.",
    );
  });

  it.each<[FloorReason, string]>([
    [
      FloorReason.Gateway,
      "10db's rules judge this session, not auto mode: auto mode doesn't run through a gateway account yet. A call those rules can't settle waits on a card.",
    ],
    [
      FloorReason.Setting,
      `10db's rules judge this session, not auto mode: "Lanes decide routine permissions" is off in Settings. A call those rules can't settle waits on a card.`,
    ],
    [
      FloorReason.Codex,
      "10db's rules judge this session: Codex has no judge in 10db yet. A call those rules can't settle waits on a card.",
    ],
    [
      FloorReason.LeftAutoMode,
      "Claude Code stopped running in auto mode during this session, so 10db's rules judge its calls from here. A call those rules can't settle waits on a card.",
    ],
  ])('%s says why', (reason, text) => {
    expect(floorNoticeText(reason, 'any-model')).toBe(text);
  });
});
