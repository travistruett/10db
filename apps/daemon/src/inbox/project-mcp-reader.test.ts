import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpVerdict, type ProjectDto } from '@10db/contracts';
import { createTestStore, recordMcpApproval, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import type { AwsCredentialsExporter } from '../environment';
import { createEventBus, createStateStore } from '../events';
import type { Logger } from '../log';
import { readRepoMcp } from '../sessions';
import { createInboxService, type InboxService } from './service';
import { createProjectMcpReader } from './project-mcp-reader';

let close: () => void;
let store: Store;
let project: ProjectDto;
let repo: { path: string; cleanup(): void };
let flags: string[];
let inbox: InboxService;
let logs: { fields: Record<string, unknown>; msg: string | undefined }[];

const logger: Logger = {
  debug: () => undefined,
  info: (fields, msg) => {
    logs.push({ fields: { ...fields }, msg });
  },
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
};

beforeEach(() => {
  ({ store, close } = createTestStore());
  repo = tempDir('project-mcp-reader');
  project = seedProject(store, { repoPath: repo.path });
  flags = [];
  logs = [];
  const real = createInboxService({
    state: createStateStore(store, createEventBus()),
    onParkedAnswer: () => undefined,
  });
  inbox = {
    ...real,
    flag: (input) => {
      flags.push(input.title);
      return real.flag(input);
    },
  };
});
afterEach(() => {
  close();
  repo.cleanup();
});

const BILLING = {
  command: 'uvx',
  args: ['awslabs.billing-cost-management-mcp-server@0.0.44'],
  env: { AWS_PROFILE: 'orgtools-prod', AWS_REGION: 'us-east-1' },
};
const CREDENTIALS = { AWS_ACCESS_KEY_ID: 'AKIAFAKE', AWS_SECRET_ACCESS_KEY: 'fake-secret' };

function approveAll(): void {
  store.write((ctx) => {
    for (const { review } of readRepoMcp(repo.path).servers)
      recordMcpApproval(ctx, {
        projectId: project.id,
        serverName: review.name,
        configHash: review.configHash,
        verdict: McpVerdict.Approved,
        variables: [],
        hosts: [],
        sourceInboxId: null,
      });
  });
}

function reader(exportAwsCredentials: AwsCredentialsExporter) {
  const state = createStateStore(store, createEventBus());
  return createProjectMcpReader({ state, inbox, logger, exportAwsCredentials });
}

describe('the project MCP reader', () => {
  it('passes an approved AWS server credentials, not the profile, and logs names only', async () => {
    writeFileSync(
      join(repo.path, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'aws-billing': BILLING } }),
    );
    approveAll();
    const asked: string[] = [];
    const mcp = await reader((profile) => {
      asked.push(profile);
      return Promise.resolve(CREDENTIALS);
    }).read({
      project,
      checkout: repo.path,
      workstreamId: null,
      env: { PATH: '/usr/bin', HOME: '/h' },
    });
    expect(asked).toEqual(['orgtools-prod']);
    expect(Object.keys(mcp.servers)).toEqual(['aws-billing']);
    expect(flags).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.msg).toBe('project mcp servers');
    expect(logs[0]?.fields).toMatchObject({
      workstreamId: null,
      passed: [
        {
          name: 'aws-billing',
          transport: 'stdio',
          envKeys: ['AWS_ACCESS_KEY_ID', 'AWS_REGION', 'AWS_SECRET_ACCESS_KEY', 'HOME', 'PATH'],
        },
      ],
      pending: [],
      failed: [],
    });
    expect(JSON.stringify(logs)).not.toContain('fake-secret');
  });
});
