import { MantineProvider } from '@mantine/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { cssVariablesResolver, theme } from '../../theme';
import { PlanComposer } from './plan-composer';
import type { LateOutcome } from './late-outcome';

const LATE_FAILURE = 'The daemon is restarting';

/** A composer whose parent can hand it a late outcome and settle the send it started. */
function mount(
  failure: string = LATE_FAILURE,
  agentLabel = 'Claude Code',
): {
  arrive: (draft: string) => void;
  settle: () => void;
  refuse: (message: string) => void;
} {
  let settle = (): void => undefined;
  let refuse: (message: string) => void = () => undefined;
  let arrive: (draft: string) => void = () => undefined;
  function Host() {
    const [late, setLate] = useState<LateOutcome | null>(null);
    arrive = (draft) => {
      setLate({ refused: [], failure, draft });
    };
    return (
      <PlanComposer
        firstRun={false}
        answering={false}
        agentLabel={agentLabel}
        proposing={false}
        proposeLabel="Propose"
        canPropose={false}
        nothingDecided={false}
        onSend={() =>
          new Promise<void>((resolve, reject) => {
            settle = resolve;
            refuse = (message) => {
              reject(new Error(message));
            };
          })
        }
        onPropose={() => undefined}
        onStop={() => undefined}
        error={null}
        files={[]}
        onFiles={() => Promise.resolve([])}
        late={late}
        onLateTaken={() => {
          setLate(null);
        }}
        onDraft={() => undefined}
      />
    );
  }
  render(
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      <Host />
    </MantineProvider>,
  );
  return {
    arrive: (draft) => {
      act(() => {
        arrive(draft);
      });
    },
    settle: () => {
      act(() => {
        settle();
      });
    },
    refuse: (message) => {
      act(() => {
        refuse(message);
      });
    },
  };
}

const input = (): HTMLTextAreaElement => screen.getByLabelText<HTMLTextAreaElement>('Message');

describe('the composer’s input and a late failed text', () => {
  it('keeps a failed text restored during another send after that send succeeds', async () => {
    const { arrive, settle } = mount();
    fireEvent.change(input(), { target: { value: 'new message' } });
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });
    arrive('first message');
    expect(input().value).toBe('first message\n\nnew message');

    settle();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('data-loading')).toBe(false);
    });
    expect(input().value).toBe('first message');
  });

  it('clears the input when the send it started succeeds and nothing was restored', async () => {
    const { settle } = mount();
    fireEvent.change(input(), { target: { value: 'new message' } });
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });

    settle();

    await waitFor(() => {
      expect(input().value).toBe('');
    });
  });

  it('restores a failed text that is a substring of what was typed', () => {
    const { arrive } = mount();
    fireEvent.change(input(), { target: { value: 'look at this' } });

    arrive('ok');

    expect(input().value).toBe('ok\n\nlook at this');
  });
});

describe('the composer’s alert', () => {
  it.each([
    ['a failure to reach Claude Code', 'Claude Code', "Couldn't reach Claude Code"],
    ['a failure to reach Codex', 'Codex', "Couldn't reach Codex"],
  ])('titles %s', (_name, agentLabel, title) => {
    const failure = LATE_FAILURE;
    const { arrive } = mount(failure, agentLabel);
    arrive('a message');

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(title);
    expect(alert.textContent).toContain(failure);
    expect(screen.queryAllByRole('alert')).toHaveLength(1);
  });
});

describe('a send the daemon refuses', () => {
  it('says why in the alert that names the agent, and keeps the text', async () => {
    const { refuse } = mount(LATE_FAILURE, 'Codex');
    fireEvent.change(input(), { target: { value: 'a message' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    refuse('The database is locked');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't reach Codex");
    expect(alert.textContent).toContain('The database is locked');
    expect(input().value).toBe('a message');
  });
});

describe('Enter in the input', () => {
  it('does not send on the Enter that ends an IME composition, and sends on a plain one', async () => {
    mount();
    fireEvent.change(input(), { target: { value: 'a message' } });
    const sending = (): boolean =>
      screen.getByRole('button', { name: 'Send' }).hasAttribute('data-loading');

    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 });
    expect(sending()).toBe(false);

    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 13 });
    await waitFor(() => {
      expect(sending()).toBe(true);
    });
  });
});
