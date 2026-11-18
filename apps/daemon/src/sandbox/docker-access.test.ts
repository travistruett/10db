import { describe, expect, it } from 'vitest';
import { dockerAccess, dockerEnvNames } from './docker-access';

const HOME = '/Users/builder';

describe('dockerAccess', () => {
  it('opens the engine sockets, the one DOCKER_HOST names, and the CLI files, and nothing else', () => {
    const { sockets, reads } = dockerAccess(HOME, {});
    expect
      .soft(sockets, 'Docker Desktop, Colima, OrbStack and Rancher Desktop sockets')
      .toEqual(
        expect.arrayContaining([
          '/var/run/docker.sock',
          `${HOME}/.docker/run/docker.sock`,
          `${HOME}/.colima/default/docker.sock`,
          `${HOME}/.orbstack/run/docker.sock`,
          `${HOME}/.rd/docker.sock`,
        ]),
      );
    expect
      .soft(reads, 'the CLI, its plugins and the contexts it reads')
      .toEqual(
        expect.arrayContaining([
          '/Applications/Docker.app',
          `${HOME}/.docker/config.json`,
          `${HOME}/.docker/cli-plugins`,
          `${HOME}/.docker/contexts`,
        ]),
      );
    expect.soft(reads, 'no other file of ~/.docker').not.toContain(`${HOME}/.docker`);

    expect
      .soft(dockerAccess(HOME, { DOCKER_HOST: 'unix:///opt/vm/docker.sock' }).sockets, 'unix host')
      .toContain('/opt/vm/docker.sock');
    const tcp = dockerAccess(HOME, { DOCKER_HOST: 'tcp://10.0.0.5:2375' }).sockets;
    expect.soft(tcp, 'tcp host').not.toContain('10.0.0.5:2375');
    expect
      .soft(
        tcp.every((path) => path.startsWith('/')),
        'tcp host: only paths',
      )
      .toBe(true);
    const unspellable = dockerAccess(HOME, { DOCKER_HOST: 'unix:///opt/a*b/docker.sock' }).sockets;
    expect
      .soft(
        unspellable.some((path) => path.includes('*')),
        'a socket the profile cannot spell',
      )
      .toBe(false);
  });
});

describe('dockerEnvNames', () => {
  it('lets the names that point the CLI at the engine through, and no credential', () => {
    const passed = dockerEnvNames({
      DOCKER_HOST: 'unix:///x',
      DOCKER_CONTEXT: 'desktop-linux',
      COMPOSE_PROJECT_NAME: 'amps',
      COMPOSE_FILE: 'docker-compose.yml',
      DOCKER_AUTH_CONFIG: '{}',
      DOCKER_CONFIG: '/tmp/x',
      OTHER: '1',
    });
    expect(passed.sort()).toEqual([
      'COMPOSE_FILE',
      'COMPOSE_PROJECT_NAME',
      'DOCKER_CONTEXT',
      'DOCKER_HOST',
    ]);
  });
});
