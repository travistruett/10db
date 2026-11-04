import { MantineProvider } from '@mantine/core';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { cssVariablesResolver, theme } from '../../theme';
import { Composer } from './composer';
import type { LateOutcome } from './late-outcome';

const LATE_FAILURE = 'The daemon is restarting';

/** A composer whose parent can hand it a late outcome and settle the send it started. */
function mount(): {
  arrive: (draft: string) => void;
  settle: () => void;
} {
  let settle = (): void => undefined;
  let arrive: (draft: string) => void = () => undefined;
  function Host() {
    const [late, setLate] = useState<LateOutcome | null>(null);
    arrive = (draft) => {
      setLate({ refused: [], failure: LATE_FAILURE, draft });
    };
    return (
      <Composer
        firstRun={false}
        answering={false}
        proposing={false}
        proposeLabel="Propose"
        canPropose={false}
        onSend={() =>
          new Promise<void>((resolve) => {
            settle = resolve;
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
