import {
  JudgeDecision,
  type DecisionStatsDto,
  type JudgeStatusDto,
  type ShadowAgreementDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { useJudgeStatus } from '../../daemon/judge-queries';
import { accountDto } from '../../test/account-fixtures';
import { daemonUrl, renderWithDaemonAndRouter, server } from '../../test/daemon';
import {
  decisionModelDto,
  decisionStatsDto,
  judgeStatusDto,
  serveJudge,
} from '../../test/judge-fixtures';
import { DecisionDrawer } from './decision-drawer';

const DECISION = JudgeDecision.QuestionRoute;
const work = accountDto({ kind: 'openrouter', label: 'Work key', secretSet: true });

function keyedStatus(
  floor = 0.8,
  extra: Partial<JudgeStatusDto> = {},
  decision: JudgeDecision = DECISION,
): JudgeStatusDto {
  const base = judgeStatusDto();
  return judgeStatusDto({
    config: {
      ...base.config,
      accountId: work.id,
      decisions: {
        ...base.config.decisions,
        [decision]: { ...base.config.decisions[decision], floor },
      },
    },
    account: { id: work.id, label: work.label, secretSet: true, secretState: 'set' },
    ...extra,
  });
}

/** The drawer inside a page that reads the judge's status as the section does, so a save comes back. */
function Harness({
  decision = DECISION,
  stats,
  shadow,
  statsFailed = false,
}: {
  readonly decision?: JudgeDecision;
  readonly stats?: DecisionStatsDto;
  readonly shadow?: ShadowAgreementDto;
  /** The stats could not be read: the page passes no entry and says so. */
  readonly statsFailed?: boolean;
}) {
  const status = useJudgeStatus();
  const [open, setOpen] = useState<JudgeDecision | null>(decision);
  if (status.data === undefined) return null;
  return (
    <DecisionDrawer
      decision={open}
      status={status.data}
      stats={stats}
      statsFailed={statsFailed}
      shadow={shadow}
      models={[decisionModelDto()]}
      onClose={() => {
        setOpen(null);
      }}
    />
  );
}

const saves = (sent: ReturnType<typeof serveJudge>) =>
  sent.filter((r) => r.method === 'PATCH' && r.path === '/judge');

const slider = () => screen.findByRole('slider', { name: 'Sure enough' });

const answers = (...confidences: number[]) =>
  confidences.map((confidence) => ({ model: 'typesafe/jev-1.13', confidence }));

const ONE_CALL = 1;

describe('DecisionDrawer', () => {
  it('says what the decision asks and what 10db does', async () => {
    serveJudge({ status: keyedStatus(), accounts: [work] });
    await renderWithDaemonAndRouter(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Who a question goes to' });
    expect(within(dialog).getByText(/Which of the project’s routes a question/)).toBeTruthy();
    expect(within(dialog).getByText('On each answer')).toBeTruthy();
    expect(within(dialog).getByText(/the card goes to its people/)).toBeTruthy();
    expect(within(dialog).getByText('When it isn’t sure')).toBeTruthy();
    expect(within(dialog).getByText(/suggested under Ask Someone/)).toBeTruthy();
  });

  it('its switch patches that decision alone', async () => {
    const sent = serveJudge({ status: keyedStatus(), accounts: [work] });
    await renderWithDaemonAndRouter(<Harness />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Who a question goes to' }));
    await waitFor(() => {
      expect(saves(sent).map((r) => r.body)).toEqual([
        { decisions: { question_route: { enabled: false } } },
      ]);
    });
  });

  it('sure enough previews against the builder’s answers and saves once', async () => {
    const sent = serveJudge({ status: keyedStatus(0.8), accounts: [work] });
    await renderWithDaemonAndRouter(
      <Harness
        stats={decisionStatsDto(DECISION, { calls: 4, answers: answers(0.6, 0.85, 0.9, 0.95) })}
      />,
    );
    const thumb = await slider();
    expect(
      screen.getByText('At 80%, 10db would have acted on 3 of your last 4 answers.'),
    ).toBeTruthy();
    for (let i = 0; i < 10; i += 1) fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    expect(
      screen.getByText('At 90%, 10db would have acted on 2 of your last 4 answers.'),
    ).toBeTruthy();
    await waitFor(() => {
      expect(saves(sent)).toHaveLength(1);
    });
    expect(saves(sent)[0]?.body).toEqual({ decisions: { question_route: { floor: 0.9 } } });
    // The saved floor comes back and the slider stays where it was moved.
    await waitFor(() => {
      expect(thumb.getAttribute('aria-valuenow')).toBe('90');
    });
  });

  it('moving away and back saves nothing', async () => {
    const sent = serveJudge({ status: keyedStatus(), accounts: [work] });
    await renderWithDaemonAndRouter(<Harness />);
    const thumb = await slider();
    // Moved away and back: the value is the one drawn before the edit began.
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    fireEvent.keyDown(thumb, { key: 'ArrowLeft' });
    fireEvent.blur(thumb);
    // A later move is saved alone, so the earlier edit sent nothing.
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    fireEvent.blur(thumb);
    await waitFor(() => {
      expect(saves(sent)).toHaveLength(1);
    });
    expect(saves(sent)[0]?.body).toEqual({ decisions: { question_route: { floor: 0.81 } } });
  });

  it('closing the drawer right after a move still saves it', async () => {
    const sent = serveJudge({ status: keyedStatus(0.8), accounts: [work] });
    await renderWithDaemonAndRouter(<Harness />);
    const thumb = await slider();
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    fireEvent.keyDown(thumb, { key: 'Escape' });
    await waitFor(() => {
      expect(saves(sent)).toHaveLength(1);
    });
    expect(saves(sent)[0]?.body).toEqual({ decisions: { question_route: { floor: 0.81 } } });
  });

  it('the preview says when another model answered', async () => {
    serveJudge({ status: keyedStatus(0.8), accounts: [work] });
    await renderWithDaemonAndRouter(
      <Harness
        stats={decisionStatsDto(DECISION, {
          calls: 2,
          answers: [
            { model: 'old/model', confidence: 0.9 },
            { model: 'typesafe/jev-1.13', confidence: 0.9 },
          ],
        })}
      />,
    );
    expect(
      await screen.findByText(/Some were answered by old\/model, not the model picked now\./),
    ).toBeTruthy();
  });

  it('a saved floor below 50% shows at 50% and says what is saved, and saves nothing until moved', async () => {
    const sent = serveJudge({ status: keyedStatus(0.3), accounts: [work] });
    await renderWithDaemonAndRouter(<Harness />);
    const thumb = await slider();
    expect(thumb.getAttribute('aria-valuenow')).toBe('50');
    expect(screen.getByText('Saved at 30%.')).toBeTruthy();
    await screen.findByText('Last 30 days');
    expect(saves(sent)).toHaveLength(0);
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    await waitFor(() => {
      expect(saves(sent)).toHaveLength(1);
    });
    expect(saves(sent)[0]?.body).toEqual({ decisions: { question_route: { floor: 0.51 } } });
  });

  it('with the judge off its controls are disabled and its numbers still show', async () => {
    serveJudge({ status: keyedStatus(0.8, { off: true }), accounts: [work] });
    await renderWithDaemonAndRouter(
      <Harness stats={decisionStatsDto(DECISION, { calls: 4, acted: 3, answers: answers(0.9) })} />,
    );
    const thumb = await slider();
    expect(screen.getByRole('switch', { name: 'Who a question goes to' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(thumb.getAttribute('aria-disabled')).toBe('true');
    expect(
      screen.getByText(/At 80%, 10db would have acted on 1 of your last 1 answers\./),
    ).toBeTruthy();
    expect(screen.getByText(/4 calls/)).toBeTruthy();
  });

  it('shows the last 30 days: counts, cost and median time', async () => {
    serveJudge({ status: keyedStatus(), accounts: [work] });
    await renderWithDaemonAndRouter(
      <Harness
        stats={decisionStatsDto(DECISION, {
          calls: 10,
          acted: 6,
          belowFloor: 2,
          // A count of timed-out calls, not a wait: named so the load-tolerance check doesn't read it as one.
          fallbacks: { off: 0, no_key: 0, timeout: ONE_CALL, error: 1 },
          costUsd: 0.0123,
          medianLatencyMs: 410,
        })}
      />,
    );
    const text = (await screen.findByText(/10 calls/)).textContent;
    for (const part of [
      '6 acted',
      '2 not sure enough',
      '1 timed out',
      '1 failed',
      '$0.0123',
      '0.4 s',
    ]) {
      expect(text).toContain(part);
    }
    expect(text).not.toContain('no key');
  });

  it('says No calls in the last 30 days for a zero entry', async () => {
    serveJudge({ status: keyedStatus(), accounts: [work] });
    await renderWithDaemonAndRouter(<Harness stats={decisionStatsDto(DECISION)} />);
    expect(await screen.findByText('No calls in the last 30 days')).toBeTruthy();
  });

  it('its recent calls are that decision’s', async () => {
    const sent = serveJudge({ status: keyedStatus(), accounts: [work] });
    await renderWithDaemonAndRouter(<Harness />);
    await screen.findByRole('table', { name: 'Recent decisions: Who a question goes to' });
    await waitFor(() => {
      expect(sent.filter((r) => r.path === '/judge/calls/page').at(-1)?.query).toEqual({
        limit: '25',
        offset: '0',
        decision: 'question_route',
      });
    });
  });

  it('shows the decision’s status under the title, with no key when there is none', async () => {
    serveJudge({ status: judgeStatusDto() });
    await renderWithDaemonAndRouter(<Harness />);
    const dialog = await screen.findByRole('dialog', { name: 'Who a question goes to' });
    expect(within(dialog).getByText('Acting')).toBeTruthy();
    expect(within(dialog).getByText('· no key')).toBeTruthy();
  });

  it('shows the daemon’s refusal under the switch when its save fails', async () => {
    serveJudge({ status: keyedStatus(), accounts: [work] });
    server.use(
      http.patch(daemonUrl('/judge'), () =>
        HttpResponse.json({ error: 'invalid', message: 'Saving is refused.' }, { status: 400 }),
      ),
    );
    await renderWithDaemonAndRouter(<Harness />);
    fireEvent.click(await screen.findByRole('switch', { name: 'Who a question goes to' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Saving is refused.');
    expect(alert.closest('[role="dialog"]')).not.toBeNull();
  });

  it('shows the refusal under the slider when its save fails', async () => {
    serveJudge({ status: keyedStatus(), accounts: [work] });
    server.use(
      http.patch(daemonUrl('/judge'), () =>
        HttpResponse.json({ error: 'invalid', message: 'Floor refused.' }, { status: 400 }),
      ),
    );
    await renderWithDaemonAndRouter(<Harness />);
    const thumb = await slider();
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    fireEvent.blur(thumb);
    expect((await screen.findByRole('alert')).textContent).toContain('Floor refused.');
  });

  it('says the recent answers could not be read when the stats are unavailable', async () => {
    serveJudge({ status: keyedStatus(), accounts: [work] });
    await renderWithDaemonAndRouter(<Harness statsFailed />);
    expect(await screen.findByText('Your recent answers could not be read.')).toBeTruthy();
    expect(screen.queryByText(/No answers in the last 30 days/)).toBeNull();
  });

  it('previews a floor saved outside 50 to 99 at its own percent', async () => {
    serveJudge({ status: keyedStatus(0.3), accounts: [work] });
    await renderWithDaemonAndRouter(
      <Harness
        stats={decisionStatsDto(DECISION, { calls: 3, answers: answers(0.35, 0.4, 0.9) })}
      />,
    );
    expect(
      await screen.findByText('At 30%, 10db would have acted on 3 of your last 3 answers.'),
    ).toBeTruthy();
  });

  it('says would have counted as sure for a shadow decision', async () => {
    serveJudge({ status: keyedStatus(0.8, {}, JudgeDecision.ShapeReady), accounts: [work] });
    await renderWithDaemonAndRouter(
      <Harness
        decision={JudgeDecision.ShapeReady}
        stats={decisionStatsDto(JudgeDecision.ShapeReady, { calls: 2, answers: answers(0.9, 0.5) })}
      />,
    );
    expect(
      await screen.findByText('At 80%, 10db would have counted as sure 1 of your last 2 answers.'),
    ).toBeTruthy();
  });

  describe('Plan decisions', () => {
    it('say they are in shadow with their agreement, and note when they are asked', async () => {
      serveJudge({
        status: keyedStatus(0.8, {}, JudgeDecision.ShapeRecord),
        accounts: [work],
      });
      await renderWithDaemonAndRouter(
        <Harness
          decision={JudgeDecision.ShapeRecord}
          shadow={{
            decision: 'shape_record',
            answered: 25,
            scored: 20,
            agreed: 18,
            canShow: true,
          }}
        />,
      );
      const dialog = await screen.findByRole('dialog', { name: 'Record as a decision?' });
      expect(
        within(dialog).getByText('In shadow: 18 of 20 scored answers agreed (90%)'),
      ).toBeTruthy();
      expect(within(dialog).getByText('Ready to show')).toBeTruthy();
      expect(within(dialog).getByText(/Send brainstorm messages to fast models/)).toBeTruthy();
    });

    it('says when nothing is scored yet, and sends its switch', async () => {
      const sent = serveJudge({
        status: keyedStatus(0.8, {}, JudgeDecision.ShapeReady),
        accounts: [work],
      });
      await renderWithDaemonAndRouter(
        <Harness
          decision={JudgeDecision.ShapeReady}
          shadow={{ decision: 'shape_ready', answered: 0, scored: 0, agreed: 0, canShow: false }}
        />,
      );
      expect(await screen.findByText('In shadow: No scored answers yet')).toBeTruthy();
      expect(screen.queryByText('Ready to show')).toBeNull();
      fireEvent.click(screen.getByRole('switch', { name: 'Enough to propose' }));
      await waitFor(() => {
        expect(saves(sent).map((r) => r.body)).toEqual([
          { decisions: { shape_ready: { enabled: false } } },
        ]);
      });
    });
  });

  describe('Model', () => {
    const models = [
      decisionModelDto(),
      decisionModelDto({ id: '~typesafe/jev-latest', name: 'Jev Latest', latest: true }),
      decisionModelDto({
        id: 'respan/span-01-lite:free',
        name: 'Span 01 Lite (free)',
        maker: 'Respan',
        inputUsdPerMillion: 0,
      }),
      decisionModelDto({
        id: 'cloudflare/clairic',
        name: 'Clairic',
        maker: 'Cloudflare',
        inputUsdPerMillion: 0.1,
        cantCall:
          "10db can't call this model yet: OpenRouter serves it for extractions, not decisions.",
      }),
    ];

    it("lists OpenRouter's decision models with their price, the latest and the ones 10db can't call", async () => {
      serveJudge({ status: keyedStatus(), accounts: [work], models });
      await renderWithDaemonAndRouter(<Harness />);
      const select = await screen.findByRole('combobox', { name: 'Model' });
      await waitFor(() => {
        expect(select).toHaveProperty('value', 'Jev 1.13');
      });
      fireEvent.click(select);
      const latest = await screen.findByRole('option', { name: /Jev Latest/, hidden: true });
      expect(
        within(latest).getByText(/Always TypeSafe's newest · \$0\.042 per million input tokens/),
      ).toBeTruthy();
      const free = screen.getByRole('option', { name: /Span 01 Lite/, hidden: true });
      expect(within(free).getByText(/respan\/span-01-lite:free · Free/)).toBeTruthy();
      const clairic = screen.getByRole('option', { name: /Clairic/, hidden: true });
      expect(
        clairic.getAttribute('aria-disabled') ?? clairic.getAttribute('data-combobox-disabled'),
      ).toBeTruthy();
      expect(within(clairic).getByText(/can't call this model yet/)).toBeTruthy();
    });

    it('keeps the saved model in view and offers Try Again when the list cannot be read', async () => {
      serveJudge({ status: keyedStatus(), accounts: [work], models });
      let failing = true;
      server.use(
        http.get(daemonUrl('/judge/models'), () =>
          failing
            ? HttpResponse.json({ error: 'upstream', message: 'HTTP 503' }, { status: 502 })
            : HttpResponse.json({ models, fetchedAt: '2026-11-13T12:00:00.000Z' }),
        ),
      );
      await renderWithDaemonAndRouter(<Harness />);
      expect(await screen.findByText(/could not be read/)).toBeTruthy();
      expect(screen.getByText('typesafe/jev-1.13')).toBeTruthy();
      failing = false;
      fireEvent.click(screen.getByRole('button', { name: 'Try Again' }));
      expect(await screen.findByRole('combobox', { name: 'Model' })).toBeTruthy();
    });

    it("says so when the saved model is one 10db can't call", async () => {
      const keyed = keyedStatus();
      serveJudge({
        status: {
          ...keyed,
          config: {
            ...keyed.config,
            decisions: {
              ...keyed.config.decisions,
              question_route: { enabled: true, model: 'cloudflare/clairic', floor: 0.8 },
            },
          },
        },
        accounts: [work],
        models,
      });
      await renderWithDaemonAndRouter(<Harness />);
      // Beside the field, not only in its closed list's option.
      await waitFor(() => {
        const beside = screen
          .getAllByText(/OpenRouter serves it for extractions/)
          .filter((el) => el.closest('[role="option"]') === null);
        expect(beside).toHaveLength(1);
      });
    });

    it('sends the model picked, which the daemon saves once it answers a test decision', async () => {
      const sent = serveJudge({ status: keyedStatus(), accounts: [work], models });
      await renderWithDaemonAndRouter(<Harness />);
      fireEvent.click(await screen.findByRole('combobox', { name: 'Model' }));
      fireEvent.click(await screen.findByRole('option', { name: /Jev Latest/, hidden: true }));
      await waitFor(() => {
        expect(saves(sent).map((r) => r.body)).toContainEqual({
          decisions: { question_route: { model: '~typesafe/jev-latest' } },
        });
      });
      await waitFor(() => {
        expect(screen.queryByText(/a test decision…/)).toBeNull();
        expect(screen.getByRole('combobox', { name: 'Model' })).toHaveProperty(
          'value',
          'Jev Latest',
        );
      });
    });

    it('says why a model was refused and keeps the one saved', async () => {
      serveJudge({
        status: keyedStatus(),
        accounts: [work],
        models,
        refuseModel:
          "~typesafe/jev-latest didn't answer a test decision, so it wasn't saved: OpenRouter answered HTTP 400",
      });
      await renderWithDaemonAndRouter(<Harness />);
      fireEvent.click(await screen.findByRole('combobox', { name: 'Model' }));
      fireEvent.click(await screen.findByRole('option', { name: /Jev Latest/, hidden: true }));
      expect(await screen.findByText(/didn't answer a test decision/)).toBeTruthy();
      expect(screen.getByRole('combobox', { name: 'Model' })).toHaveProperty('value', 'Jev 1.13');
    });

    it('asks for an account under Paid by instead of listing models when there is none', async () => {
      serveJudge({ status: judgeStatusDto() });
      server.use(http.get(daemonUrl('/accounts'), () => HttpResponse.json([])));
      await renderWithDaemonAndRouter(<Harness />);
      expect(await screen.findByText(/choose an account under Paid by/)).toBeTruthy();
      expect(screen.getByText('typesafe/jev-1.13')).toBeTruthy();
      expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
    });
  });
});
