// Spike 3: (A) auto-compaction can be disabled per session; (C, run first as the control) an allowed compaction
// emits compact_boundary and a SessionStart(source=compact) hook whose additionalContext reaches the model (the
// post-compaction re-injection point); (B) a PreCompact hook can block a compaction, and which output shape does it.
import type { HookCallback, HookJSONOutput, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { makeFixtureRepo } from './fixture-repo.ts';
import { check, finish, info, partial } from './report.ts';
import { baseOptions, openConversation, resultText } from './session.ts';

const boundaries = (ms: SDKMessage[]) => ms.filter((m) => m.type === 'system' && m.subtype === 'compact_boundary');

// A: auto-compaction is controlled per session through Options.settings. The first live run found it already
// off by default here, so A also sets it on explicitly, and records the default for sonnet as well as haiku.
{
  const usageWith = async (extra: Parameters<typeof baseOptions>[1]) => {
    const c = openConversation(baseOptions(makeFixtureRepo(), extra));
    await c.send('Reply OK.');
    const u = await c.q.getContextUsage();
    await c.close();
    return { enabled: u.isAutoCompactEnabled, threshold: u.autoCompactThreshold ?? null, maxTokens: u.maxTokens, rawMaxTokens: u.rawMaxTokens };
  };
  const uOff = await usageWith({ settings: { autoCompactEnabled: false } });
  const uDefault = await usageWith({});
  const uOn = await usageWith({ settings: { autoCompactEnabled: true } });
  const uSonnet = await usageWith({ model: 'sonnet' });
  const uSonnetOn = await usageWith({ model: 'sonnet', settings: { autoCompactEnabled: true } });
  info('A: auto-compaction (haiku off / default / on; sonnet default / on)', { off: uOff, default: uDefault, on: uOn, sonnetDefault: uSonnet, sonnetOn: uSonnetOn });
  check('A: auto-compaction controlled per session via Options.settings', uOff.enabled === false && uOn.enabled === true, `off=${uOff.enabled} default=${uDefault.enabled} on=${uOn.enabled}`);
}

// C runs before B: it is the control showing that /compact on this conversation size really compacts.
// It allows compaction, observes the boundary and re-injects context through SessionStart(source=compact).
let controlCompacted = false;
{
  const sources: string[] = [];
  const preCompact: HookCallback = async (input) => {
    info('C: PreCompact input', input);
    return {};
  };
  const sessionStart: HookCallback = async (input) => {
    const source = input.hook_event_name === 'SessionStart' ? input.source : 'n/a';
    sources.push(source);
    return source === 'compact'
      ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'The re-injection canary is MARIGOLD.' } }
      : {};
  };
  const c = openConversation(baseOptions(makeFixtureRepo(), { hooks: { PreCompact: [{ hooks: [preCompact] }], SessionStart: [{ hooks: [sessionStart] }] } }));
  await c.send('Remember the number 41. Reply OK.');
  const turn = await c.send('/compact');
  const ask = await c.send('What is the re-injection canary word? Reply with the word only, or NONE.');
  await c.close();
  const b = boundaries(turn.messages)[0];
  controlCompacted = b !== undefined;
  info('C: compact_boundary', b ?? null);
  info('C: SessionStart sources seen', sources);
  check('C: allowed /compact emits compact_boundary', b !== undefined, b ? JSON.stringify(b).slice(0, 160) : 'none');
  check('C: SessionStart fires with source=compact', sources.includes('compact'), JSON.stringify(sources));
  check('C: re-injected context reaches the model', /MARIGOLD/i.test(resultText(ask)), resultText(ask).slice(0, 40));
}

// B: two blocking shapes for PreCompact, tried against a manual /compact. A missing boundary only counts as
// "blocked" when the control (C) compacted a conversation of the same size.
const blockShapes: Record<string, HookJSONOutput> = {
  'decision-block': { decision: 'block', reason: '10db: hand off instead of compacting' },
  'continue-false': { continue: false, stopReason: '10db: hand off instead of compacting' },
};
const blocked: string[] = [];
for (const [shape, output] of Object.entries(blockShapes)) {
  let fired = 0;
  const preCompact: HookCallback = async () => {
    fired += 1;
    return output;
  };
  const c = openConversation(baseOptions(makeFixtureRepo(), { hooks: { PreCompact: [{ hooks: [preCompact] }] } }));
  await c.send('Remember the number 41. Reply OK.');
  const turn = await c.send('/compact');
  const after = await c.send('What number did I ask you to remember? Reply with the number only.');
  const all = await c.close();
  info(`B ${shape}: /compact result`, { subtype: turn.result?.subtype, text: resultText(turn).slice(0, 200) });
  info(`B ${shape}: session still usable`, { answer: resultText(after).slice(0, 40), error: String(all.error ?? 'none') });
  info(`B ${shape}: hook frames`, all.messages.filter((m) => m.type === 'system' && String(m.subtype).startsWith('hook_')).map((m) => JSON.stringify(m).slice(0, 200)));
  info(`B ${shape}: reason text visible to the model or user`, JSON.stringify(all.messages).includes('hand off instead of compacting'));
  if (!controlCompacted) partial(`B ${shape}: PreCompact blocks manual compaction`, 'control did not compact; a missing boundary proves nothing');
  else if (fired === 0) partial(`B ${shape}: PreCompact fired`, 'hook never fired on /compact');
  else {
    // Each shape is a record; the requirement is that at least one shape blocks.
    const didBlock = boundaries(turn.messages).length === 0;
    if (didBlock) blocked.push(shape);
    info(`B ${shape}: PreCompact blocks manual compaction`, { blocked: didBlock, fired, boundaries: boundaries(turn.messages).length });
  }
}
if (controlCompacted) check('B: at least one PreCompact output shape blocks manual compaction', blocked.length > 0, JSON.stringify(blocked));

finish();
