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
}: {
  readonly decision?: JudgeDecision;
  readonly stats?: DecisionStatsDto;
  readonly shadow?: ShadowAgreementDto;
}) {
  const status = useJudgeStatus();
  const [open, setOpen] = useState<JudgeDecision | null>(decision);
  if (status.data === undefined) return null;
  return (
    <DecisionDrawer
      decision={open}
      status={status.data}
      stats={stats}
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

  it('a click on the thumb that doesn’t move it saves nothing', async () => {
    const sent = serveJudge({ status: keyedStatus(), accounts: [work] });
    await renderWithDaemonAndRouter(<Harness />);
    const thumb = await slider();
    fireEvent.mouseDown(thumb);
    fireEvent.mouseUp(thumb);
    // Moved away and back: the value is the one drawn before the edit began.
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    fireEvent.keyDown(thumb, { key: 'ArrowLeft' });
    fireEvent.blur(thumb);
    await screen.findByText('Last 30 days');
    expect(saves(sent)).toHaveLength(0);
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
    expect(thumb.getAttribute('data-disabled') ?? thumb.getAttribute('aria-disabled')).toBeTruthy();
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
          fallbacks: { off: 0, no_key: 0, timeout: 1, error: 1 },
          costUsd: 0.0123,
          medianLatencyMs: 410,
        })}
      />,
    );
    const text = (await screen.findByText(/10 calls/)).textContent;
    for (const part of [
      '6 acted',
      '2 not sure enough',
      'timed out 1',
      'failed 1',
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
    ];

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
