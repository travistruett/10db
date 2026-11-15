import type { Effort } from '@10db/contracts';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../test/daemon';
import { modelEffortDto, modelRowDto } from '../test/model-fixtures';
import { ModelMenu, type ModelMenuProps } from './model-menu';

// The composer's model chip: its menu, the Effort submenu and More models.

const OFFERED = [
  { model: 'gpt-5', tier: 'capable' as const },
  { model: 'claude-haiku-5-5', tier: 'efficient' as const },
  { model: 'claude-sonnet-5-5', tier: 'balanced' as const },
  { model: 'claude-opus-5-5', tier: 'capable' as const },
  { model: 'claude-fable-5-1', tier: 'frontier' as const },
  { model: 'house-model', tier: null },
];

function serveModels(): void {
  server.use(
    http.get(daemonUrl('/models'), () =>
      HttpResponse.json([
        modelRowDto({
          model: 'claude-opus-5-5',
          name: 'Opus 5.5',
          tier: 'capable',
          efforts: [modelEffortDto({ effort: 'max' }), modelEffortDto({ effort: 'high' })],
        }),
        modelRowDto({
          model: 'gpt-5',
          name: 'GPT-5',
          tier: 'capable',
          efforts: [modelEffortDto({ effort: 'xhigh' }), modelEffortDto({ effort: 'low' })],
        }),
        modelRowDto({ model: 'claude-haiku-5-5', name: 'Haiku 5.5', tier: 'efficient' }),
        modelRowDto({
          model: 'claude-sonnet-5-5',
          name: 'Sonnet 5.5',
          tier: 'balanced',
          efforts: [modelEffortDto({ effort: 'high' }), modelEffortDto({ effort: 'low' })],
        }),
        modelRowDto({ model: 'claude-fable-5-1', name: 'Fable 5.1', tier: 'frontier' }),
      ]),
    ),
    ...baseHandlers(),
  );
}

interface Picks {
  readonly list: { model: string | null; effort: Effort | null }[];
}

/** Holds the pick as a screen does, and records each one sent. */
function Held(props: Partial<ModelMenuProps> & { readonly picks: Picks; readonly start?: Effort }) {
  const { picks, start, ...rest } = props;
  const [state, setState] = useState<{ model: string | null; effort: Effort | null }>({
    model: null,
    effort: start ?? null,
  });
  return (
    <ModelMenu
      offered={OFFERED}
      default="claude-opus-5-5"
      picked={state.model}
      effort={state.effort}
      busy={false}
      {...rest}
      onPick={(model, effort) => {
        picks.list.push({ model, effort });
        setState({ model, effort });
      }}
    />
  );
}

const chip = (): Promise<HTMLElement> => screen.findByRole('button', { name: 'Model and effort' });

async function openMenu(): Promise<HTMLElement> {
  // A menu that was just picked from is still fading out.
  await waitFor(() => {
    expect(screen.queryByRole('menu', { hidden: true })).toBeNull();
  });
  fireEvent.click(await chip());
  return screen.findByRole('menu', { hidden: true });
}

/** Opens a submenu by its name; it is the last menu in the page. */
async function openSub(name: string): Promise<HTMLElement> {
  const before = screen.queryAllByRole('menu', { hidden: true }).length;
  // The keyboard's way in: hover opens it after a delay.
  fireEvent.keyDown(await screen.findByRole('menuitem', { name: new RegExp(name), hidden: true }), {
    key: 'ArrowRight',
  });
  return waitFor(() => {
    const menus = screen.getAllByRole('menu', { hidden: true });
    expect(menus.length).toBeGreaterThan(before);
    return menus.at(-1) ?? document.body;
  });
}

describe('ModelMenu', () => {
  it('reads "Model Effort" on the chip, and lists the models as radios with a check on the current one', async () => {
    serveModels();
    const picks: Picks = { list: [] };
    renderWithDaemon(<Held picks={picks} effort="high" />);
    await waitFor(async () => {
      expect((await chip()).textContent).toBe('Opus 5.5 High');
    });
    const menu = await openMenu();
    const radios = within(menu).getAllByRole('menuitemradio', { hidden: true });
    expect(radios.map((r) => r.textContent)).toEqual([
      'GPT-5',
      'Sonnet 5.5',
      'Opus 5.5 (default)',
      'Fable 5.1',
    ]);
    expect(radios.filter((r) => r.getAttribute('aria-checked') === 'true')).toHaveLength(1);
    expect(
      screen
        .getByRole('menuitemradio', { name: /Opus 5.5/, hidden: true })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('the Effort submenu lists only the efforts of the model in use, and follows a pick of another provider’s model', async () => {
    serveModels();
    const picks: Picks = { list: [] };
    renderWithDaemon(<Held picks={picks} />);
    await waitFor(async () => {
      expect((await chip()).textContent).toBe('Opus 5.5');
    });
    await openMenu();
    const claude = await openSub('Effort');
    await waitFor(() => {
      expect(
        within(claude)
          .getAllByRole('menuitemradio', { hidden: true })
          .map((r) => r.textContent),
      ).toEqual(['Automatic', 'High', 'Max']);
    });
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'GPT-5', hidden: true }));
    expect(picks.list).toEqual([{ model: 'gpt-5', effort: null }]);
    await openMenu();
    const codex = await openSub('Effort');
    await waitFor(() => {
      expect(
        within(codex)
          .getAllByRole('menuitemradio', { hidden: true })
          .map((r) => r.textContent),
      ).toEqual(['Automatic', 'Low', 'Xhigh']);
    });
  });

  it('keeps the effort across a model that offers it and drops it for one that does not; the default model sends null', async () => {
    serveModels();
    const picks: Picks = { list: [] };
    renderWithDaemon(<Held picks={picks} start="high" />);
    await waitFor(async () => {
      expect((await chip()).textContent).toBe('Opus 5.5 High');
    });
    for (const name of ['Sonnet 5.5', 'GPT-5', /Opus 5.5/]) {
      await openMenu();
      fireEvent.click(await screen.findByRole('menuitemradio', { name, hidden: true }));
    }
    expect(picks.list).toEqual([
      { model: 'claude-sonnet-5-5', effort: 'high' },
      { model: 'gpt-5', effort: null },
      { model: null, effort: null },
    ]);
  });

  it('an effort alone is sent with the model unchanged', async () => {
    serveModels();
    const picks: Picks = { list: [] };
    renderWithDaemon(<Held picks={picks} />);
    await waitFor(async () => {
      expect((await chip()).textContent).toBe('Opus 5.5');
    });
    await openMenu();
    const sub = await openSub('Effort');
    fireEvent.click(await within(sub).findByRole('menuitemradio', { name: 'Max', hidden: true }));
    expect(picks.list).toEqual([{ model: null, effort: 'max' }]);
    await waitFor(async () => {
      expect((await chip()).textContent).toBe('Opus 5.5 Max');
    });
  });

  it('More models lists the rest and its search narrows them', async () => {
    serveModels();
    const picks: Picks = { list: [] };
    renderWithDaemon(<Held picks={picks} />);
    await waitFor(async () => {
      expect((await chip()).textContent).toBe('Opus 5.5');
    });
    await openMenu();
    const more = await openSub('More models');
    expect(
      within(more)
        .getAllByRole('menuitemradio', { hidden: true })
        .map((r) => r.textContent),
    ).toEqual(['Haiku 5.5', 'house-model']);
    fireEvent.change(within(more).getByPlaceholderText('Search models'), {
      target: { value: 'hai' },
    });
    expect(
      within(more)
        .getAllByRole('menuitemradio', { hidden: true })
        .map((r) => r.textContent),
    ).toEqual(['Haiku 5.5']);
    fireEvent.click(within(more).getByRole('menuitemradio', { name: 'Haiku 5.5', hidden: true }));
    expect(picks.list).toEqual([{ model: 'claude-haiku-5-5', effort: null }]);
  });

  it('is off while a turn runs, with the reason on hover', async () => {
    serveModels();
    renderWithDaemon(<Held picks={{ list: [] }} busy />);
    const button = (await chip()) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    // The disabled button hears no pointer; its wrapper does.
    const wrapper = button.closest('span');
    expect(wrapper).not.toBeNull();
    fireEvent.mouseEnter(wrapper ?? button);
    expect(await screen.findByText('Change the model between turns')).toBeTruthy();
  });

  it('keeps the stored effort across a model pick while the model list has not loaded', async () => {
    server.use(
      http.get(daemonUrl('/models'), () => HttpResponse.json([])),
      ...baseHandlers(),
    );
    const picks: Picks = { list: [] };
    renderWithDaemon(<Held picks={picks} start="high" />);
    await openMenu();
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'gpt-5', hidden: true }));
    expect(picks.list).toEqual([{ model: 'gpt-5', effort: 'high' }]);
  });

  it('shows the daemon’s refusal beside the chip', async () => {
    serveModels();
    renderWithDaemon(<Held picks={{ list: [] }} error="Not available on this account" />);
    expect(await screen.findByText('Not available on this account')).toBeTruthy();
  });

  it('is absent when the account offers no model', () => {
    serveModels();
    renderWithDaemon(<Held picks={{ list: [] }} offered={[]} />);
    expect(screen.queryByRole('button', { name: 'Model and effort' })).toBeNull();
  });
});
