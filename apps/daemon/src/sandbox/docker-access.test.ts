import { describe, expect, it } from 'vitest';
import { dockerAccess, dockerEnvNames } from './docker-access';

const HOME = '/Users/builder';

describe('dockerAccess', () => {
  it('names the sockets Docker Desktop, Colima, OrbStack and Rancher Desktop listen on', () => {
    const { sockets } = dockerAccess(HOME, {});
    expect(sockets).toEqual(
      expect.arrayContaining([
        '/var/run/docker.sock',
        `${HOME}/.docker/run/docker.sock`,
        `${HOME}/.colima/default/docker.sock`,
        `${HOME}/.orbstack/run/docker.sock`,
        `${HOME}/.rd/docker.sock`,
      ]),
    );
  });

  it("adds the socket DOCKER_HOST names, and nothing for a host that isn't a socket", () => {
    expect(dockerAccess(HOME, { DOCKER_HOST: 'unix:///opt/vm/docker.sock' }).sockets).toContain(
      '/opt/vm/docker.sock',
    );
    const tcp = dockerAccess(HOME, { DOCKER_HOST: 'tcp://10.0.0.5:2375' });
    expect(tcp.sockets).not.toContain('10.0.0.5:2375');
    expect(tcp.sockets.every((path) => path.startsWith('/'))).toBe(true);
  });

  it('refuses a DOCKER_HOST socket the profile cannot spell', () => {
    const { sockets } = dockerAccess(HOME, { DOCKER_HOST: 'unix:///opt/a*b/docker.sock' });
    expect(sockets.some((path) => path.includes('*'))).toBe(false);
  });

  it('opens the CLI, its plugins and the contexts it reads, and no other file of ~/.docker', () => {
    const { reads } = dockerAccess(HOME, {});
    expect(reads).toEqual(
      expect.arrayContaining([
        '/Applications/Docker.app',
        `${HOME}/.docker/config.json`,
        `${HOME}/.docker/cli-plugins`,
        `${HOME}/.docker/contexts`,
      ]),
    );
    expect(reads).not.toContain(`${HOME}/.docker`);
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
