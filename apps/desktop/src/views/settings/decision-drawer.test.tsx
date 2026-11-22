import { JudgeDecision } from '@10db/contracts';
import { screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useJudgeStatus } from '../../daemon/judge-queries';
import { accountDto } from '../../test/account-fixtures';
import { renderWithDaemonAndRouter } from '../../test/daemon';
import { decisionModelDto, judgeStatusDto, serveJudge } from '../../test/judge-fixtures';
import { DecisionDrawer } from './decision-drawer';

const work = accountDto({ kind: 'openrouter', label: 'Work key', secretSet: true });

/** The drawer inside a page that reads the judge's status as the section does. */
function Harness() {
  const status = useJudgeStatus();
  if (status.data === undefined) return null;
  return (
    <DecisionDrawer
      decision={JudgeDecision.QuestionRoute}
      status={status.data}
      stats={undefined}
      statsFailed={false}
      shadow={undefined}
      models={[decisionModelDto()]}
      onClose={() => undefined}
    />
  );
}

it('says what the decision asks and what 10db does', async () => {
  const base = judgeStatusDto();
  serveJudge({
    status: judgeStatusDto({
      config: { ...base.config, accountId: work.id },
      account: { id: work.id, label: work.label, secretSet: true, secretState: 'set' },
    }),
    accounts: [work],
  });
  await renderWithDaemonAndRouter(<Harness />);
  const dialog = await screen.findByRole('dialog', { name: 'Who a Question Goes To' });
  expect(within(dialog).getByText(/Which of the project’s routes a question/)).toBeTruthy();
  expect(within(dialog).getByText('On Each Answer')).toBeTruthy();
  expect(within(dialog).getByText(/the card goes to its people/)).toBeTruthy();
  expect(within(dialog).getByText('When It Isn’t Sure')).toBeTruthy();
  expect(within(dialog).getByText(/suggested under Ask Someone/)).toBeTruthy();
});
