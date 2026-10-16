// Spike 2: getContextUsage() is callable between turns and mid-turn (as M1b calls it, once per assistant message),
// grows as context grows, and its percentage scale is settled from the token counts, not guessed.
import type { SDKControlGetContextUsageResponse } from '@anthropic-ai/claude-agent-sdk';
import { makeFixtureRepo } from './fixture-repo.ts';
import { check, finish, info } from './report.ts';
import { baseOptions, openConversation } from './session.ts';

type Usage = SDKControlGetContextUsageResponse;
const timed = async (f: () => Promise<Usage>): Promise<{ u: Usage; ms: number }> => {
  const t0 = performance.now();
  const u = await f();
  return { u, ms: Math.round(performance.now() - t0) };
};

// Mid-turn: fire getContextUsage on the first assistant message without blocking the message pump.
let midTurn: Promise<{ ok: boolean; ms: number; percentage?: number; detail?: string }> | undefined;
let q: ReturnType<typeof openConversation>['q'] | undefined;
const convo = openConversation(baseOptions(makeFixtureRepo(), { maxTurns: 3 }), {
  onMessage: (m) => {
    if (m.type !== 'assistant' || midTurn || !q) return;
    const t0 = performance.now();
    midTurn = q.getContextUsage({ detail: 'summary' }).then(
      (u) => ({ ok: true, ms: Math.round(performance.now() - t0), percentage: u.percentage }),
      (e: unknown) => ({ ok: false, ms: Math.round(performance.now() - t0), detail: String(e) }),
    );
  },
});
q = convo.q;
await convo.send('Reply with the single word ONE.');
const first = await timed(() => convo.q.getContextUsage({ detail: 'summary' }));
const firstFull = await timed(() => convo.q.getContextUsage());
await convo.send(`Filler to grow the context: ${'lorem ipsum dolor sit amet '.repeat(300)} Reply with the single word TWO.`);
const second = await timed(() => convo.q.getContextUsage({ detail: 'summary' }));
const all = await convo.close();
const mid = await Promise.race([midTurn ?? Promise.resolve({ ok: false, ms: -1, detail: 'never fired' }), new Promise<{ ok: false; ms: number; detail: string }>((r) => setTimeout(() => r({ ok: false, ms: -1, detail: 'blocked > 10 s' }), 10_000))]);

const pick = (u: Usage) => ({ percentage: u.percentage, totalTokens: u.totalTokens, maxTokens: u.maxTokens, rawMaxTokens: u.rawMaxTokens, isAutoCompactEnabled: u.isAutoCompactEnabled, autoCompactThreshold: u.autoCompactThreshold, model: u.model });
info('usage after turn 1 (summary)', pick(first.u));
info('usage after turn 1 (full)', pick(firstFull.u));
info('usage after turn 2 (summary)', pick(second.u));
info('latency ms', { summary: first.ms, full: firstFull.ms, summaryTurn2: second.ms, midTurn: mid.ms });
info('mid-turn call', mid);
const lastResult = all.messages.filter((m) => m.type === 'result').at(-1);
info('result.usage of last turn', lastResult?.type === 'result' ? lastResult.usage : null);

// Scale: percentage / (total/max) is ~100 for a 0-100 scale and ~1 for a 0-1 scale. The first live run showed
// percentage rounded to an integer, which skews the ratio at low usage, so a value within 0.5 of
// 100 × total / max also settles the 0-100 scale.
const ratio = second.u.percentage / (second.u.totalTokens / second.u.maxTokens);
const exactPct = (100 * second.u.totalTokens) / second.u.maxTokens;
const rounded = Number.isInteger(second.u.percentage) && Math.abs(second.u.percentage - exactPct) <= 0.5;
info('percentage vs 100 × total / max', { percentage: second.u.percentage, exact: exactPct, roundedToInteger: rounded });
const scale = Math.abs(ratio - 100) < 5 ? '0-100 of maxTokens' : rounded ? '0-100 of maxTokens (rounded to an integer)' : Math.abs(ratio - 1) < 0.05 ? '0-1 of maxTokens' : `other (ratio ${ratio.toFixed(3)})`;
console.log(`SCALE=${scale}`);
info('scale', { ratio, scale });
const threshold = second.u.autoCompactThreshold;
const thresholdPct = threshold === undefined ? undefined : threshold > 100 ? (100 * threshold) / second.u.maxTokens : threshold <= 1 ? threshold * 100 : threshold;
info('autoCompactThreshold as % of maxTokens', { raw: threshold ?? null, pct: thresholdPct ?? null });

// The live models report a 1M window, while M1b's live run assumes 200k. sdk.d.ts says maxTokens is "the resolved
// autocompact window", so check whether a per-session autoCompactWindow sets the denominator.
const windowed = openConversation(baseOptions(makeFixtureRepo(), { settings: { autoCompactEnabled: true, autoCompactWindow: 200_000 } }));
await windowed.send('Reply with the single word OK.');
const w = await windowed.q.getContextUsage({ detail: 'summary' });
await windowed.close();
info('with settings.autoCompactWindow = 200000', pick(w));
console.log(`WINDOW_SETS_MAXTOKENS=${w.maxTokens === 200_000 ? 'yes' : 'no'}`);

check('percentage is a number', typeof first.u.percentage === 'number' && typeof second.u.percentage === 'number', `${first.u.percentage} → ${second.u.percentage}`);
check('maxTokens known', first.u.maxTokens > 0, String(first.u.maxTokens));
check('scale settled', !scale.startsWith('other'), scale);
check('usage grows with context', second.u.totalTokens > first.u.totalTokens, `${first.u.totalTokens} → ${second.u.totalTokens}`);
check('callable mid-turn without blocking', mid.ok, JSON.stringify(mid));
check('callable between turns without ending the session', all.error === undefined, String(all.error ?? 'ok'));
check('auto-compact threshold above the 85% firm nudge', thresholdPct === undefined || thresholdPct > 85, `threshold ≈ ${thresholdPct?.toFixed(1) ?? 'unknown'}%`);
finish();
