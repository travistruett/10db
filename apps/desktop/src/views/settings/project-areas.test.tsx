import { fireEvent, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderApp, server } from '../../test/daemon';
import { projectDto } from '../../test/fixtures';

const project = projectDto({
  areas: [
    { name: 'api', globs: ['src/api/**'] },
    { name: 'ui', globs: ['src/ui/**'] },
  ],
  hazards: [{ name: 'deps', globs: ['**/package.json'], commands: ['pnpm add'] }],
});

describe('the areas and hazards editor', () => {
  it('lists each area and hazard as a row that opens to its editor, with paths in words', async () => {
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      ...baseHandlers(),
    );
    renderApp('/settings/areas');
    fireEvent.click(await screen.findByText('api'));
    expect(await screen.findByDisplayValue('src/api/**')).toBeTruthy();
    expect(screen.getByText(/src\/api\/ and everything inside it/)).toBeTruthy();
    fireEvent.click(screen.getByText('deps'));
    expect(await screen.findByText(/package\.json in any folder/)).toBeTruthy();
  });
});
