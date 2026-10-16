import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'daemon',
    environment: 'node',
    testTimeout: 30_000,
    // Tests and the git children they spawn ignore the contributor's global git config.
    env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  },
});
