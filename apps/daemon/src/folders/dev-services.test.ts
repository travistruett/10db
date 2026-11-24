import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTempRepoWithOrigin, isolatedGitEnv } from '../../test/fixtures';
import { createGit } from '../git';
import { composeServices, readComposeServices, type ComposeServices } from './dev-services';

describe('composeServices', () => {
  it('reads only compose-valid names from the compose files, and nothing from a file it cannot read', () => {
    const rows: [string, [string, string][], ComposeServices | null][] = [
      [
        'keys and container_name; the project from the folder',
        [
          [
            'app/docker-compose.yml',
            'services:\n  backend:\n    image: x\n  db:\n    container_name: app-db\n  frontend: {}\n',
          ],
        ],
        {
          files: ['app/docker-compose.yml'],
          project: 'app',
          services: ['backend', 'db', 'frontend'],
          containerNames: ['app-db'],
        },
      ],
      [
        'an invalid name is dropped',
        [
          [
            'compose.yaml',
            'name: Bad Project\nservices:\n  "db\\nhost: prod": {}\n  "web app": {}\n  api:\n    container_name: "prod.example.com; rm -rf /"\n  worker: {}\n',
          ],
        ],
        {
          files: ['compose.yaml'],
          project: null,
          services: ['api', 'worker'],
          containerNames: [],
        },
      ],
      ['malformed YAML', [['compose.yaml', 'services: [\n  - : :\n']], null],
      ['services: null', [['compose.yaml', 'name: demo\nservices: null\n']], null],
      [
        'an override is merged, unique and sorted',
        [
          ['compose.yaml', 'name: demo\nservices:\n  web: {}\n  db: {}\n'],
          ['compose.override.yaml', 'services:\n  db:\n    ports: ["5432:5432"]\n  worker: {}\n'],
        ],
        {
          files: ['compose.yaml', 'compose.override.yaml'],
          project: 'demo',
          services: ['db', 'web', 'worker'],
          containerNames: [],
        },
      ],
    ];
    for (const [name, files, expected] of rows)
      expect.soft(composeServices(new Map(files)), name).toEqual(expected);
  });
});

describe('readComposeServices', () => {
  it("reads the services from origin's base, and a lane's edit to its checkout changes nothing", async () => {
    const remote = createTempRepoWithOrigin();
    const { repo } = remote;
    try {
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', repo.path, ...args], { env: isolatedGitEnv(), stdio: 'pipe' });
      writeFileSync(join(repo.path, 'compose.yaml'), 'name: demo\nservices:\n  web: {}\n');
      git('add', 'compose.yaml');
      git('commit', '-q', '-m', 'compose');
      git('push', '-q', 'origin', 'main');
      // The lane writes its checkout; the judge must not read it.
      writeFileSync(
        join(repo.path, 'compose.yaml'),
        'name: demo\nservices:\n  web: {}\n  proxy: {}\n',
      );
      expect(
        await readComposeServices(createGit(), { repoPath: repo.path, baseBranch: 'main' }),
      ).toEqual({
        files: ['compose.yaml'],
        project: 'demo',
        services: ['web'],
        containerNames: [],
      });
    } finally {
      remote.cleanup();
    }
  });
});
