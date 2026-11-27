import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { kindDto } from '../../test/playbook-fixtures';
import { KindsSection, useKindsActions } from './kinds-section';

const SECURITY = kindDto({
  key: 'security',
  label: 'Security',
  minimumRigor: 'careful',
  alwaysReviewed: true,
  toInbox: true,
  overrides: {
    review: { personaId: null, model: { kind: 'tier', tier: 'frontier' }, effort: 'high' },
  },
  position: 0,
});
const DOCS = kindDto({ key: 'docs', label: 'Docs', position: 1 });

/** The list as the Playbook's Kinds tab draws it, with the header's actions it shares. */
function Kinds() {
  return <KindsSection actions={useKindsActions()} />;
}

describe('the kinds list', () => {
  it('lists each kind with its minimum rigor and switches, in order', async () => {
    server.use(
      http.get(daemonUrl('/kinds'), () => HttpResponse.json([SECURITY, DOCS])),
      ...baseHandlers(),
    );
    renderWithDaemon(<Kinds />);
    const security = within(await screen.findByRole('row', { name: /Security/ }));
    expect(security.getByText('Careful')).toBeTruthy();
    expect(security.getByText('Always Reviewed')).toBeTruthy();
    expect(security.getByText('Inbox')).toBeTruthy();
    expect(security.getByText('Review')).toBeTruthy();
    const names = screen.getAllByRole('row').map((r) => r.textContent);
    expect(names.findIndex((n) => n.includes('Security'))).toBeLessThan(
      names.findIndex((n) => n.includes('Docs')),
    );
  });
});
