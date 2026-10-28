/**
 * Conventional Commits. The type is required because release-please reads it for version bumps. The scope
 * is optional, but when present it must be on the fixed list from governance decision G2.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      ['daemon', 'desktop', 'contracts', 'db', 'harness', 'repo', 'ci', 'docs', 'deps'],
    ],
  },
};
