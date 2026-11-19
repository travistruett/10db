import { screen } from '@testing-library/react';
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
  it('explains each area and hazard and shows paths as folder patterns with an example', async () => {
    server.use(
      http.get(daemonUrl('/projects'), () => HttpResponse.json([project])),
      ...baseHandlers(),
    );
    renderApp('/settings/areas');
    expect(
      await screen.findByText(/Tasks in different areas can run at the same time/),
    ).toBeTruthy();
    expect(screen.getByText(/Only one task at a time may change these files/)).toBeTruthy();
    expect(
      screen.getAllByText(/may change files in src\/api\/ and everything inside it/),
    ).toHaveLength(1);
    expect(screen.getAllByText(/Example: src\/api\/folder\/file/)).toHaveLength(1);
    expect(screen.getByText(/package\.json in any folder/)).toBeTruthy();
  });
});
