import {
  PassCloseAnswerDto,
  PassClosePreviewDto,
  PassCloseRequest,
  type PassViewDto,
} from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { pagesByStatus, passDto, passViewDto } from '../../test/pass-fixtures';
import { ClosePassModal } from './close-pass-modal';

const { working, ready, notStarted } = pagesByStatus();
const signedOff = { ...notStarted, signOff: 'done' as const };

function preview(overrides: Partial<PassClosePreviewDto> = {}): PassClosePreviewDto {
  return PassClosePreviewDto.parse({
    token: 'lists-1',
    unfinished: [
      {
        taskId: working.taskId,
        title: working.title,
        working: true,
        sharedUnlanded: [
          {
            seq: 3,
            paths: ['src/shared/button.tsx'],
            dropRefusal: null,
            laterPages: [],
          },
        ],
      },
      { taskId: ready.taskId, title: ready.title, working: false, sharedUnlanded: [] },
    ],
    unowned: [{ path: 'src/app.css', added: 4, removed: 1, fromBeforePass: true }],
    foreignCommits: [{ sha: 'c'.repeat(40), subject: 'fix the build by hand' }],
    summary: 'Lands 2 pages and 1 shared change on main; opens a pull request for review.',
    gate: {
      where: 'folder',
      consequence:
        'If the gate fails in your folder, the pass opens again with these pages taken out.',
    },
    ...overrides,
  });
}

/** Answers the close's lists with `lists`, then each confirm with `answers` in turn. */
function serve(lists: PassClosePreviewDto, answers: PassCloseAnswerDto[]) {
  const asked: string[] = [];
  const sent: { passId: string; body: PassCloseRequest }[] = [];
  server.use(
    http.get(daemonUrl('/passes/:passId/close'), ({ params }) => {
      asked.push(String(params['passId']));
      return HttpResponse.json(lists);
    }),
    http.post(daemonUrl('/passes/:passId/close'), async ({ params, request }) => {
      sent.push({
        passId: String(params['passId']),
        body: PassCloseRequest.parse(await request.json()),
      });
      return HttpResponse.json(answers[sent.length - 1]);
    }),
    ...baseHandlers(),
  );
  return { asked, sent };
}

function draw(view: PassViewDto) {
  const onClose = vi.fn();
  renderWithDaemon(<ClosePassModal view={view} onClose={onClose} />);
  return onClose;
}

/** The select labelled `label`: the only control of that name. */
function select(dialog: HTMLElement, label: string): HTMLElement {
  return within(dialog).getByLabelText(label);
}

/** Picks `option` in the select labelled `label`. */
async function choose(dialog: HTMLElement, label: string, option: string) {
  const input = select(dialog, label);
  fireEvent.click(input);
  const id = input.getAttribute('aria-controls');
  const list = await waitFor(() => {
    const el = id === null ? null : document.getElementById(id);
    if (el === null) throw new Error(`the ${label} list is not open`);
    return el;
  });
  fireEvent.click(within(list).getByRole('option', { name: option, hidden: true }));
}

const view = passViewDto({
  pass: passDto({ name: 'Settings pass' }),
  pages: [working, ready, signedOff],
});
const closing = PassCloseAnswerDto.parse({
  outcome: 'closing',
  pass: { ...view.pass, state: 'CLOSING' },
});

describe('ClosePassModal', () => {
  it('shows every loose end with its safe default, and closes on the choices made', async () => {
    const { asked, sent } = serve(preview(), [closing]);
    const onClose = draw(view);
    const dialog = await screen.findByRole('dialog', { name: 'Close Pass' });
    const billing = await within(dialog).findByRole('group', { name: 'Billing' });
    expect(within(billing).getByText('Working · will be stopped')).toBeTruthy();
    expect(within(dialog).getByText('+4 −1')).toBeTruthy();
    expect(within(dialog).getByText('From before the pass')).toBeTruthy();
    expect(within(dialog).getByText('These commits ride the pull request:')).toBeTruthy();
    expect(within(dialog).getByText('ccccccc fix the build by hand')).toBeTruthy();
    expect(within(dialog).getByText(preview().gate.consequence ?? '')).toBeTruthy();
    expect(within(dialog).getByText(preview().summary)).toBeTruthy();
    // Opening the modal stops nothing and sends nothing.
    expect(sent).toEqual([]);
    expect(asked).toEqual([view.pass.id]);
    await choose(dialog, 'What happens to Settings', 'Sign Off Now');
    await choose(dialog, 'Where src/app.css goes', 'Add to Settings');
    fireEvent.click(within(billing).getByRole('radio', { name: 'Drop' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close Pass' }));
    await waitFor(() => {
      expect(sent).toEqual([
        {
          passId: view.pass.id,
          body: {
            token: 'lists-1',
            pages: [
              { taskId: working.taskId, choice: 'take_out' },
              { taskId: ready.taskId, choice: 'sign_off' },
            ],
            files: [{ path: 'src/app.css', placeIn: ready.taskId }],
            shared: [{ seq: 3, choice: 'drop' }],
          },
        },
      ]);
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  it('shows the lists again with what changed marked, and confirms them with the new token', async () => {
    const again = preview({
      token: 'lists-2',
      unowned: [
        { path: 'src/app.css', added: 4, removed: 1, fromBeforePass: true },
        { path: 'src/new.css', added: 2, removed: 0, fromBeforePass: false },
      ],
    });
    const { sent } = serve(preview(), [
      PassCloseAnswerDto.parse({
        outcome: 'changed',
        preview: again,
        changed: ['src/new.css is a new edit no page owns'],
      }),
      closing,
    ]);
    const onClose = draw(view);
    const dialog = await screen.findByRole('dialog', { name: 'Close Pass' });
    const billing = await within(dialog).findByRole('group', { name: 'Billing' });
    // Choices made before the lists changed carry over to the lists shown again.
    await choose(dialog, 'What happens to Settings', 'Sign Off Now');
    fireEvent.click(within(billing).getByRole('radio', { name: 'Drop' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close Pass' }));
    // Said beside Close Pass, where the second click lands, and announced.
    const alert = within(dialog).getByRole('alert');
    expect(
      await within(alert).findByText(
        'The lists changed since you looked: src/new.css is a new edit no page owns. Check them and close again.',
      ),
    ).toBeTruthy();
    expect(select(dialog, 'Where src/new.css goes')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close Pass' }));
    await waitFor(() => {
      expect(sent.map((s) => s.body.token)).toEqual(['lists-1', 'lists-2']);
    });
    expect(sent[1]?.body).toEqual({
      token: 'lists-2',
      pages: [
        { taskId: working.taskId, choice: 'take_out' },
        { taskId: ready.taskId, choice: 'sign_off' },
      ],
      files: [
        { path: 'src/app.css', placeIn: null },
        { path: 'src/new.css', placeIn: null },
      ],
      shared: [{ seq: 3, choice: 'drop' }],
    });
  });

  it('opened again, never shows the lists an earlier opening read', async () => {
    const { asked } = serve(preview(), []);
    const { rerender } = renderWithDaemon(<ClosePassModal view={view} onClose={vi.fn()} />);
    let dialog = await screen.findByRole('dialog', { name: 'Close Pass' });
    await within(dialog).findByRole('group', { name: 'Billing' });
    rerender(<></>);
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Close Pass' })).toBeNull();
    });
    rerender(<ClosePassModal view={view} onClose={vi.fn()} />);
    dialog = await screen.findByRole('dialog', { name: 'Close Pass' });
    expect(within(dialog).queryByRole('group', { name: 'Billing' })).toBeNull();
    expect(await within(dialog).findByRole('group', { name: 'Billing' })).toBeTruthy();
    expect(asked).toEqual([view.pass.id, view.pass.id]);
  });

  it('with nothing loose, is the summary and its footer', async () => {
    serve(
      preview({
        unfinished: [],
        unowned: [],
        foreignCommits: [],
        gate: { where: 'none', consequence: null },
      }),
      [],
    );
    draw(passViewDto({ pages: [signedOff] }));
    const dialog = await screen.findByRole('dialog', { name: 'Close Pass' });
    expect(await within(dialog).findByText(preview().summary)).toBeTruthy();
    for (const section of ['Not signed off', 'Edits no page owns', 'Commits 10db did not make'])
      expect(within(dialog).queryByRole('heading', { name: section })).toBeNull();
    expect(dialog.querySelectorAll('input')).toHaveLength(0);
  });
});
