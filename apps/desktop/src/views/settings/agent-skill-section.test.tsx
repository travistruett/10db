import { AgentSkillInput, AgentSkillStatus } from '@10db/contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { AgentSkillSection } from './agent-skill-section';

const PATH = '/settings/agent-skill';
const CLAUDE_LINK = '/Users/me/.claude/skills/10db-task';
const CODEX_LINK = '/Users/me/.agents/skills/10db-task';

type Link = AgentSkillStatus['links'][number];

function link(tool: Link['tool'], over: Partial<Link> = {}): Link {
  return {
    tool,
    path: tool === 'claude_code' ? CLAUDE_LINK : CODEX_LINK,
    state: 'linked',
    target: null,
    ...over,
  };
}

function status(over: Partial<AgentSkillStatus> = {}): AgentSkillStatus {
  return AgentSkillStatus.parse({
    enabled: true,
    installable: true,
    version: 'abc123def456',
    installedVersion: 'abc123def456',
    installedPath: '/Users/me/.10db/skills/10db-task',
    links: [link('claude_code'), link('codex')],
    error: null,
    ...over,
  });
}

/** A daemon that answers the status and records what the switch sends. */
function serving(current: AgentSkillStatus): AgentSkillInput[] {
  const puts: AgentSkillInput[] = [];
  server.use(
    http.get(daemonUrl(PATH), () => HttpResponse.json(current)),
    http.put(daemonUrl(PATH), async ({ request }) => {
      const input = AgentSkillInput.parse(await request.json());
      puts.push(input);
      return HttpResponse.json({ ...current, enabled: input.enabled });
    }),
    ...baseHandlers(),
  );
  return puts;
}

describe('AgentSkillSection', () => {
  it('shows an installed, current skill with both link paths', async () => {
    serving(status());
    renderWithDaemon(<AgentSkillSection />);
    expect(await screen.findByText('Installed, current')).toBeTruthy();
    expect(screen.getByText('Agents in any repo can use 10db')).toBeTruthy();
    expect(screen.getByText(new RegExp(CLAUDE_LINK))).toBeTruthy();
    expect(screen.getByText(new RegExp(CODEX_LINK))).toBeTruthy();
  });

  it.each([
    {
      name: 'an out-of-date copy',
      over: { installedVersion: 'old000000000' },
      line: 'Installed copy is out of date',
    },
    {
      name: 'no copy',
      over: { installedVersion: null, links: [link('claude_code', { state: 'missing' })] },
      line: 'Not installed',
    },
    {
      name: 'a link that points elsewhere',
      over: {
        links: [
          link('claude_code', { state: 'points_elsewhere', target: '/Users/me/my-skill' }),
          link('codex'),
        ],
      },
      line: 'Points at /Users/me/my-skill: left as it is',
    },
    {
      name: 'a folder in the way',
      over: { links: [link('claude_code', { state: 'in_the_way' }), link('codex')] },
      line: 'A folder of yours is there: left as it is',
    },
    {
      name: 'a missing link',
      over: { links: [link('claude_code', { state: 'missing' }), link('codex')] },
      line: 'Not linked',
    },
    {
      name: 'an install error',
      over: { error: 'EACCES: permission denied' },
      line: 'EACCES: permission denied',
    },
  ])('says what $name looks like', async ({ over, line }) => {
    serving(status(over));
    renderWithDaemon(<AgentSkillSection />);
    expect(await screen.findByText(line)).toBeTruthy();
  });

  it.each([
    {
      reason: 'other_data_dir' as const,
      line: 'This 10db uses another data folder, so it installs nothing',
    },
    { reason: 'from_source' as const, line: 'This 10db runs from source, so it installs nothing' },
  ])('disables the switch and says why when $reason', async ({ reason, line }) => {
    serving(status({ installable: { reason }, installedVersion: null, version: null, links: [] }));
    renderWithDaemon(<AgentSkillSection />);
    expect(await screen.findByText(line)).toBeTruthy();
    const toggle = screen.getByRole('switch', { name: 'Agents in any repo can use 10db' });
    expect(toggle.hasAttribute('disabled')).toBe(true);
  });

  it('shows the switch off and nothing installed when the builder has turned it off', async () => {
    serving(
      status({
        enabled: false,
        installedVersion: null,
        links: [link('claude_code', { state: 'missing' }), link('codex', { state: 'missing' })],
      }),
    );
    renderWithDaemon(<AgentSkillSection />);
    expect(await screen.findByText('Not installed')).toBeTruthy();
    const toggle = screen.getByRole('switch', { name: 'Agents in any repo can use 10db' });
    expect(toggle).toHaveProperty('checked', false);
  });

  it('sends the switch to the daemon', async () => {
    const puts = serving(status());
    renderWithDaemon(<AgentSkillSection />);
    await screen.findByText('Installed, current');
    fireEvent.click(screen.getByRole('switch', { name: 'Agents in any repo can use 10db' }));
    await waitFor(() => {
      expect(puts).toEqual([{ enabled: false }]);
    });
  });
});
