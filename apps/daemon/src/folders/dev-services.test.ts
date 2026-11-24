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
            'amps/docker-compose.yml',
            'services:\n  backend:\n    image: x\n  db:\n    container_name: amps-db\n  frontend: {}\n',
          ],
        ],
        {
          files: ['amps/docker-compose.yml'],
          project: 'amps',
          services: ['backend', 'db', 'frontend'],
          containerNames: ['amps-db'],
          makeTargets: [],
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
          makeTargets: [],
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
          makeTargets: [],
        },
      ],
    ];
    for (const [name, files, expected] of rows)
      expect.soft(composeServices(new Map(files)), name).toEqual(expected);
  });
});

describe('readComposeServices', () => {
  it("reads the services and Makefile recipes from origin's base, and a lane's edit to its checkout changes nothing", async () => {
    const remote = createTempRepoWithOrigin();
    const { repo } = remote;
    try {
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', repo.path, ...args], { env: isolatedGitEnv(), stdio: 'pipe' });
      writeFileSync(join(repo.path, 'compose.yaml'), 'name: demo\nservices:\n  web: {}\n');
      writeFileSync(
        join(repo.path, 'Makefile'),
        '# Writes migration files.\nmigration:\n\t@docker compose exec web python manage.py makemigrations\n\ndb-prepare:\n\tdocker compose run --rm web python manage.py migrate\n',
      );
      git('add', 'compose.yaml', 'Makefile');
      git('commit', '-q', '-m', 'compose');
      git('push', '-q', 'origin', 'main');
      // The lane writes its checkout; the judge must not read it.
      writeFileSync(
        join(repo.path, 'compose.yaml'),
        'name: demo\nservices:\n  web: {}\n  proxy: {}\n',
      );
      writeFileSync(join(repo.path, 'Makefile'), 'migration:\n\techo nothing\n');
      expect(
        await readComposeServices(createGit(), { repoPath: repo.path, baseBranch: 'main' }),
      ).toEqual({
        files: ['compose.yaml'],
        project: 'demo',
        services: ['web'],
        containerNames: [],
        makeTargets: [
          {
            name: 'migration',
            about: ['Writes migration files.'],
            recipe: ['docker compose exec web python manage.py makemigrations'],
          },
          {
            name: 'db-prepare',
            about: [],
            recipe: ['docker compose run --rm web python manage.py migrate'],
          },
        ],
      });
    } finally {
      remote.cleanup();
    }
  });
});
