import { CodeHighlightAdapterProvider } from '@mantine/code-highlight';
import { MantineProvider } from '@mantine/core';
import { render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { shikiAdapter } from '../conversation/shiki';
import { cssVariablesResolver, theme } from '../theme';

function Themed({ children }: { readonly children: ReactNode }) {
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      <CodeHighlightAdapterProvider adapter={shikiAdapter}>{children}</CodeHighlightAdapterProvider>
    </MantineProvider>
  );
}

/** One component inside the app's theme, for a view that reads nothing from the daemon. */
export function renderWithTheme(ui: ReactElement) {
  return render(<Themed>{ui}</Themed>);
}
