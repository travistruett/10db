import { describe, expect, it } from 'vitest';
import { composeServices, type ComposeServices } from './dev-services';

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
        { files: ['compose.yaml'], project: null, services: ['api', 'worker'], containerNames: [] },
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
