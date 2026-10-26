import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { baseHandlers, renderWithDaemon, server } from '../../test/daemon';
import { batchDto } from '../../test/fixtures';
import { BatchHistory } from './batch-history';

describe('BatchHistory', () => {
  const url = 'https://github.com/acme/widgets/pull/1';
  const second = batchDto({
    title: 'Beta second',
    state: 'OPEN',
    branch: '10db/beta-second',
    prUrl: null,
  });
  const first = batchDto({
    title: 'Alpha first',
    state: 'SHIPPED',
    branch: '10db/alpha-first',
    prUrl: url,
  });

  it('lists each batch with its state, branch and pull request, in the order given', async () => {
    server.use(...baseHandlers());
    renderWithDaemon(<BatchHistory batches={[second, first]} />);
    const list = await screen.findByRole('list', { name: 'Batches' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);

    const open = within(screen.getByRole('listitem', { name: 'Beta second' }));
    expect(open.getByText('Open')).toBeTruthy();
    expect(open.getByText('10db/beta-second')).toBeTruthy();
    expect(open.queryByRole('link', { name: 'Pull request' })).toBeNull();

    const shipped = within(screen.getByRole('listitem', { name: 'Alpha first' }));
    expect(shipped.getByText('Shipped')).toBeTruthy();
    expect(shipped.getByText('10db/alpha-first')).toBeTruthy();
    expect(shipped.getByRole('link', { name: 'Pull request' }).getAttribute('href')).toBe(url);
  });
});
