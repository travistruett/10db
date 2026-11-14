import type { AgentAccountKind } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { SHAPE_AGENT_MODELS } from './confinement';
import { shapeAgentModels } from './agent-models';
import { shapeSystemPrompt } from './policy';

describe('the models a Plan session may launch an agent on', () => {
  it.each<{ kind: AgentAccountKind; models: readonly string[] }>([
    { kind: 'claude_subscription', models: SHAPE_AGENT_MODELS },
    { kind: 'anthropic_api_key', models: SHAPE_AGENT_MODELS },
    // On these the aliases resolve to older models than the account lists, so an agent runs on the session's.
    { kind: 'bedrock', models: [] },
    { kind: 'gateway', models: [] },
    { kind: 'codex_signin', models: [] },
  ])('are $models on $kind', ({ kind, models }) => {
    expect(shapeAgentModels(kind)).toEqual(models);
  });
});

describe('the Plan prompt’s model names', () => {
  it('lists the aliases the account’s agents take', () => {
    expect(shapeSystemPrompt(SHAPE_AGENT_MODELS)).toMatch(
      /model "opus", "fable", "sonnet" or "haiku"/,
    );
  });

  it('says agents run on the session’s model when the account offers no alias', () => {
    const prompt = shapeSystemPrompt([]);
    expect(prompt).toMatch(/runs? on yours|run on the session's model/);
    expect(prompt).not.toMatch(/"opus"|"fable"|"sonnet"|"haiku"/);
  });
});
