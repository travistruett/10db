import { describe, expect, it } from 'vitest';
import {
  appAddressCandidates,
  appAddressFiles,
  chooseAppAddress,
  NOTHING_ANSWERED,
  type AppAddressInput,
  type Listener,
} from './detect-app-address';

const REPO = '/Users/me/app';

const input = (over: Partial<AppAddressInput>): AppAddressInput => ({
  repoPath: REPO,
  texts: new Map(),
  listeners: [],
  uiUnit: null,
  daemonPort: 4317,
  ...over,
});

const listener = (port: number, over: Partial<Listener> = {}): Listener => ({
  port,
  host: '127.0.0.1',
  cwd: `${REPO}/web`,
  command: 'node',
  ...over,
});

const compose = (body: string) => `services:\n${body}`;

interface Row {
  readonly name: string;
  readonly input: Partial<AppAddressInput>;
  readonly expected: readonly [url: string, source: string][];
}

const rows: Row[] = [
  {
    name: 'a listener inside the repository',
    input: { listeners: [listener(3000)] },
    expected: [['http://localhost:3000', 'listening now: node in web on port 3000']],
  },
  {
    name: 'a listener at the repository root',
    input: { listeners: [listener(3000, { cwd: REPO, host: '*' })] },
    expected: [['http://localhost:3000', 'listening now: node in the repository on port 3000']],
  },
  {
    name: 'a listener outside the repository is not the app',
    input: { listeners: [listener(3000, { cwd: '/Users/me/other' })] },
    expected: [],
  },
  {
    name: 'a listener beside the repository with a name it starts with',
    input: { listeners: [listener(3000, { cwd: `${REPO}-old` })] },
    expected: [],
  },
  {
    name: 'a listener with no working directory',
    input: { listeners: [listener(3000, { cwd: null })] },
    expected: [],
  },
  {
    name: 'a listener on another interface',
    input: { listeners: [listener(3000, { host: '192.168.1.4' })] },
    expected: [],
  },
  {
    name: 'a listener on every interface, IPv6',
    input: { listeners: [listener(5173, { host: '[::]' })] },
    expected: [['http://localhost:5173', 'listening now: node in web on port 5173']],
  },
  {
    name: "10db's own port",
    input: { listeners: [listener(4317)] },
    expected: [],
  },
  {
    name: 'compose proxy, short syntax',
    input: {
      texts: new Map([
        [
          'docker-compose.yml',
          compose('  db:\n    ports: ["5433:5432"]\n  proxy:\n    ports:\n      - "8800:80"\n'),
        ],
      ]),
    },
    expected: [['http://localhost:8800', 'from docker-compose.yml: proxy publishes 8800']],
  },
  {
    name: 'compose services in name order, whatever the file order',
    input: {
      texts: new Map([
        [
          'compose.yaml',
          compose('  frontend:\n    ports: ["3000:3000"]\n  nginx:\n    ports: ["80:80"]\n'),
        ],
      ]),
    },
    expected: [
      ['http://localhost', 'from compose.yaml: nginx publishes 80'],
      ['http://localhost:3000', 'from compose.yaml: frontend publishes 3000'],
    ],
  },
  {
    name: 'compose long syntax, loopback host ip',
    input: {
      texts: new Map([
        [
          'docker-compose.yml',
          compose(
            '  web:\n    ports:\n      - target: 80\n        published: "8080"\n        host_ip: 127.0.0.1\n',
          ),
        ],
      ]),
    },
    expected: [['http://localhost:8080', 'from docker-compose.yml: web publishes 8080']],
  },
  {
    name: 'compose ports with an address, a protocol and a default',
    input: {
      texts: new Map([
        [
          'docker-compose.yml',
          compose(
            '  app:\n    ports:\n      - "127.0.0.1:9000:80/tcp"\n  web:\n    ports:\n      - "${WEB_PORT:-9100}:80"\n',
          ),
        ],
      ]),
    },
    expected: [
      ['http://localhost:9100', 'from docker-compose.yml: web publishes 9100'],
      ['http://localhost:9000', 'from docker-compose.yml: app publishes 9000'],
    ],
  },
  {
    name: 'compose ports that publish nowhere this Mac reaches, or no fixed port',
    input: {
      texts: new Map([
        [
          'docker-compose.yml',
          compose(
            '  proxy:\n    ports:\n      - "10.0.0.2:8800:80"\n      - "3000"\n      - "8000-8005:80-85"\n      - "53:53/udp"\n      - "${PORT}:80"\n',
          ),
        ],
      ]),
    },
    expected: [],
  },
  {
    name: 'compose with anchors and merge keys',
    input: {
      texts: new Map([
        [
          'docker-compose.yml',
          'x-web: &web\n  ports: ["8800:80"]\nservices:\n  proxy:\n    <<: *web\n    image: nginx\n',
        ],
      ]),
    },
    expected: [['http://localhost:8800', 'from docker-compose.yml: proxy publishes 8800']],
  },
  {
    name: 'compose that is not YAML',
    input: { texts: new Map([['docker-compose.yml', 'services: [\n']]) },
    expected: [],
  },
  {
    name: 'a service of another name is not the app',
    input: {
      texts: new Map([['docker-compose.yml', compose('  mailpit:\n    ports: ["8826:8025"]\n')]]),
    },
    expected: [],
  },
  {
    name: 'tauri devUrl',
    input: {
      texts: new Map([
        ['apps/desktop/src-tauri/tauri.conf.json', '{"build":{"devUrl":"http://localhost:1420"}}'],
      ]),
    },
    expected: [['http://localhost:1420', 'from apps/desktop/src-tauri/tauri.conf.json: devUrl']],
  },
  {
    name: 'tauri devUrl on another machine',
    input: {
      texts: new Map([
        ['src-tauri/tauri.conf.json', '{"build":{"devUrl":"http://10.0.0.2:1420"}}'],
      ]),
    },
    expected: [],
  },
  {
    name: 'an app origin in a workflow, the .env example and compose environment',
    input: {
      texts: new Map([
        ['.github/workflows/ci.yml', 'env:\n  BASE_URL: http://127.0.0.1:4000/app\n'],
        ['.env.example', 'DATABASE_URL=postgres://db\nAPP_URL="http://localhost:4100"\n'],
        [
          'docker-compose.yml',
          compose(
            '  api:\n    environment:\n      NEXT_PUBLIC_APP_ORIGIN: http://localhost:4200\n',
          ),
        ],
      ]),
    },
    expected: [
      ['http://127.0.0.1:4000', 'from .github/workflows/ci.yml: BASE_URL'],
      ['http://localhost:4100', 'from .env.example: APP_URL'],
      ['http://localhost:4200', 'from docker-compose.yml: NEXT_PUBLIC_APP_ORIGIN'],
    ],
  },
  {
    name: 'an app origin that is not on this Mac',
    input: { texts: new Map([['.env.example', 'APP_URL=https://app.example.com\n']]) },
    expected: [],
  },
  {
    name: 'vite server.port, then the dev script, then the framework default',
    input: {
      uiUnit: 'web',
      texts: new Map([
        [
          'web/vite.config.ts',
          'export default { plugins: [], server: { host: true, port: 4000 } };',
        ],
        [
          'web/package.json',
          '{"scripts":{"dev":"vite --port 4100"},"devDependencies":{"vite":"7.0.0"}}',
        ],
      ]),
    },
    expected: [
      ['http://localhost:4000', 'from web/vite.config.ts: server.port'],
      ['http://localhost:4100', 'from web/package.json: the dev script'],
      ['http://localhost:5173', "Vite's default port"],
    ],
  },
  {
    name: 'next with -p',
    input: {
      uiUnit: 'web',
      texts: new Map([
        [
          'web/package.json',
          '{"scripts":{"dev":"next dev -p 3100"},"dependencies":{"next":"16.0.0"}}',
        ],
      ]),
    },
    expected: [
      ['http://localhost:3100', 'from web/package.json: the dev script'],
      ['http://localhost:3000', "Next.js's default port"],
    ],
  },
  {
    name: 'a package.json that is not JSON',
    input: { uiUnit: 'web', texts: new Map([['web/package.json', '{']]) },
    expected: [],
  },
  {
    name: 'the same address twice keeps its first source',
    input: {
      uiUnit: 'apps/desktop',
      texts: new Map([
        ['apps/desktop/src-tauri/tauri.conf.json', '{"build":{"devUrl":"http://localhost:1420"}}'],
        [
          'apps/desktop/vite.config.ts',
          'export default { server: { port: 1420, strictPort: true } };',
        ],
        [
          'apps/desktop/package.json',
          '{"scripts":{"dev":"vite"},"devDependencies":{"vite":"7.0.0"}}',
        ],
      ]),
    },
    expected: [
      ['http://localhost:1420', 'from apps/desktop/src-tauri/tauri.conf.json: devUrl'],
      ['http://localhost:5173', "Vite's default port"],
    ],
  },
  {
    name: 'the order: compose, tauri, origins, a listener, then the guesses',
    input: {
      uiUnit: 'web',
      listeners: [listener(3100)],
      texts: new Map([
        ['.env.example', 'APP_URL=http://localhost:4100\n'],
        ['src-tauri/tauri.conf.json', '{"build":{"devUrl":"http://localhost:1420"}}'],
        ['docker-compose.yml', compose('  proxy:\n    ports: ["8800:80"]\n')],
        [
          'web/package.json',
          '{"scripts":{"dev":"next dev -p 3200"},"dependencies":{"next":"16.0.0"}}',
        ],
      ]),
    },
    expected: [
      ['http://localhost:8800', 'from docker-compose.yml: proxy publishes 8800'],
      ['http://localhost:1420', 'from src-tauri/tauri.conf.json: devUrl'],
      ['http://localhost:4100', 'from .env.example: APP_URL'],
      ['http://localhost:3100', 'listening now: node in web on port 3100'],
      ['http://localhost:3200', 'from web/package.json: the dev script'],
      ['http://localhost:3000', "Next.js's default port"],
    ],
  },
];

describe('appAddressCandidates', () => {
  it.each(rows)('$name', ({ input: over, expected }) => {
    expect(appAddressCandidates(input(over)).map((c) => [c.url, c.source])).toEqual(expected);
  });
});

describe('appAddressFiles', () => {
  it('reads compose files, tauri configs, workflows, .env examples and the UI unit’s files', () => {
    const files = [
      'docker-compose.yml',
      'compose.override.yaml',
      'deploy/docker-compose.yml',
      '.devcontainer/docker-compose.yml',
      'docker-compose.prod.yml',
      'apps/desktop/src-tauri/tauri.conf.json',
      '.github/workflows/ci.yml',
      '.github/workflows/notes.md',
      'backend/.env.example',
      'web/package.json',
      'web/vite.config.mts',
      'other/vite.config.ts',
      'web/src/app.tsx',
    ];
    expect(appAddressFiles(files, 'web')).toEqual([
      'docker-compose.yml',
      'compose.override.yaml',
      'deploy/docker-compose.yml',
      'apps/desktop/src-tauri/tauri.conf.json',
      '.github/workflows/ci.yml',
      'backend/.env.example',
      'web/vite.config.mts',
      'web/package.json',
    ]);
  });
});

describe('chooseAppAddress', () => {
  const candidates = appAddressCandidates(
    input({
      listeners: [listener(3000)],
      texts: new Map([
        ['docker-compose.yml', compose('  proxy:\n    ports: ["8800:80"]\n')],
        ['src-tauri/tauri.conf.json', '{"build":{"devUrl":"http://localhost:1420"}}'],
        ['.env.example', 'APP_URL=http://localhost:4100\n'],
      ]),
    }),
  );

  it.each([
    {
      name: 'the first that answers wins',
      answered: [false, true, true],
      url: 'http://localhost:1420',
      note: undefined,
    },
    {
      name: 'the first answers',
      answered: [true, false, false],
      url: 'http://localhost:8800',
      note: undefined,
    },
    {
      name: 'nothing answers: the first, with a note',
      answered: [false, false, false],
      url: 'http://localhost:8800',
      note: NOTHING_ANSWERED,
    },
  ])('$name', ({ answered, url, note }) => {
    const chosen = chooseAppAddress(candidates, answered);
    expect(chosen?.url).toBe(url);
    expect(chosen?.note).toBe(note);
  });

  it('is null with no candidate', () => {
    expect(chooseAppAddress([], [])).toBeNull();
  });
});
