import { AgentSkillStatus } from '@10db/contracts';
import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { baseHandlers, daemonUrl, renderWithDaemon, server } from '../../test/daemon';
import { AgentSkillSection } from './agent-skill-section';

const CLAUDE_LINK = '/Users/me/.claude/skills/10db-task';
const CODEX_LINK = '/Users/me/.agents/skills/10db-task';

describe('AgentSkillSection', () => {
  it('shows an installed, current skill with both link paths', async () => {
    server.use(
      http.get(daemonUrl('/settings/agent-skill'), () =>
        HttpResponse.json(
          AgentSkillStatus.parse({
            enabled: true,
            installable: true,
            version: 'abc123def456',
            installedVersion: 'abc123def456',
            installedPath: '/Users/me/.10db/skills/10db-task',
            links: [
              { tool: 'claude_code', path: CLAUDE_LINK, state: 'linked', target: null },
              { tool: 'codex', path: CODEX_LINK, state: 'linked', target: null },
            ],
            error: null,
          }),
        ),
      ),
      ...baseHandlers(),
    );
    renderWithDaemon(<AgentSkillSection />);
    expect(await screen.findByText('Installed, current')).toBeTruthy();
    expect(screen.getByText('Agents in any repo can use 10db')).toBeTruthy();
    expect(screen.getByText(new RegExp(CLAUDE_LINK))).toBeTruthy();
    expect(screen.getByText(new RegExp(CODEX_LINK))).toBeTruthy();
  });
});
