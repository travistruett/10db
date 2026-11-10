import { MantineProvider } from '@mantine/core';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { cssVariablesResolver, theme } from '../theme';

/** One component inside the app's theme, for a view that reads nothing from the daemon. */
export function renderWithTheme(ui: ReactElement) {
  return render(
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      defaultColorScheme="dark"
    >
      {ui}
    </MantineProvider>,
  );
}
