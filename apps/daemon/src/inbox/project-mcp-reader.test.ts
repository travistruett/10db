import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpVerdict, type ProjectDto } from '@10db/contracts';
import { createTestStore, recordMcpApproval, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { AwsCredentialsError, type AwsCredentialsExporter } from '../environment';
import { createEventBus, createStateStore } from '../events';
import type { Logger } from '../log';
import { readRepoMcp } from '../sessions';
import { createInboxService, type InboxService } from './service';
import { createProjectMcpReader } from './project-mcp-reader';

let close: () => void;
let store: Store;
let project: ProjectDto;
let repo: { path: string; cleanup(): void };
let flags: { title: string; body: string; workstreamId: unknown }[];
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
  project = seedProject(store);
  repo = tempDir('project-mcp-reader');
  flags = [];
  logs = [];
  const real = createInboxService({
    state: createStateStore(store, createEventBus()),
    onParkedAnswer: () => undefined,
  });
  inbox = {
    ...real,
    flag: (input) => {
      flags.push({ title: input.title, body: input.body, workstreamId: input.workstreamId });
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

function declare(servers: Record<string, unknown>): void {
  writeFileSync(join(repo.path, '.mcp.json'), JSON.stringify({ mcpServers: servers }));
}

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

const read = (r: ReturnType<typeof reader>, workstreamId = null) =>
  r.read({
    project,
    checkout: repo.path,
    workstreamId,
    env: { PATH: '/usr/bin', HOME: '/h' },
  });

describe('the project MCP reader', () => {
  it('passes an approved AWS server credentials, not the profile, and logs names only', async () => {
    declare({ 'aws-billing': BILLING });
    approveAll();
    const asked: string[] = [];
    const mcp = await read(
      reader((profile) => {
        asked.push(profile);
        return Promise.resolve(CREDENTIALS);
      }),
    );
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

  it('raises the approval card and exports nothing for a server with no verdict', async () => {
    declare({ 'aws-billing': BILLING });
    const mcp = await read(reader(() => Promise.reject(new Error('must not be called'))));
    expect(mcp.servers).toEqual({});
    expect(mcp.pending.map((r) => r.name)).toEqual(['aws-billing']);
    expect(flags.map((f) => f.title)).toEqual(['Run the repo\'s MCP server "aws-billing"?']);
    expect(flags[0]?.body).toContain(
      'Gets short-lived AWS credentials for the profile orgtools-prod',
    );
  });

  it('asks again when the hosts file names another host, and the card names it', async () => {
    const hostsFile = (hosts: string[]) => {
      mkdirSync(join(repo.path, '.10db'), { recursive: true });
      writeFileSync(
        join(repo.path, '.10db', 'mcp-hosts.json'),
        JSON.stringify({ servers: { 'aws-billing': { hosts } } }),
      );
    };
    declare({ 'aws-billing': BILLING });
    hostsFile(['billing.us-east-1.amazonaws.com']);
    store.write((ctx) => {
      for (const { review } of readRepoMcp(repo.path).servers)
        recordMcpApproval(ctx, {
          projectId: project.id,
          serverName: review.name,
          configHash: review.configHash,
          verdict: McpVerdict.Approved,
          variables: [],
          hosts: review.hosts,
          sourceInboxId: null,
        });
    });
    const exporter = () => Promise.resolve(CREDENTIALS);
    const same = await read(reader(exporter));
    expect(Object.keys(same.servers)).toEqual(['aws-billing']);
    expect(flags).toEqual([]);

    hostsFile(['billing.us-east-1.amazonaws.com', 'billing.us-east-1.api.aws']);
    const changed = await read(reader(exporter));
    expect(changed.servers).toEqual({});
    expect(changed.pending.map((r) => r.name)).toEqual(['aws-billing']);
    expect(flags.map((f) => f.title)).toEqual(['Run the repo\'s MCP server "aws-billing"?']);
    expect(flags[0]?.body.split('\n')).toContain(
      'New hosts since your last approval: billing.us-east-1.api.aws',
    );
  });

  it('flags a failed export with the sign-in instruction and leaves the server out', async () => {
    declare({ 'aws-billing': BILLING });
    approveAll();
    const mcp = await read(
      reader(() =>
        Promise.reject(
          new AwsCredentialsError(
            'The AWS login for the profile "orgtools-prod" has expired. Run aws sso login --profile orgtools-prod, then try again.',
            true,
          ),
        ),
      ),
    );
    expect(mcp.servers).toEqual({});
    expect(flags.map((f) => [f.title, f.workstreamId])).toEqual([
      ['The repo\'s MCP server "aws-billing" can\'t run as written', null],
    ]);
    expect(flags[0]?.body).toContain('aws sso login --profile orgtools-prod');
    expect(logs[0]?.fields).toMatchObject({ failed: ['aws-billing'] });
  });

  it('flags a config it cannot parse, then throws', async () => {
    writeFileSync(join(repo.path, '.mcp.json'), '{ nope');
    await expect(read(reader(() => Promise.resolve({})))).rejects.toThrow('not valid JSON');
    expect(flags.map((f) => f.title)).toEqual([
      "The repo's MCP config stops sessions from starting",
    ]);
  });
});
