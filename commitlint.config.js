/** Conventional Commits with the fixed scope list from governance decision G2. */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      ['daemon', 'desktop', 'contracts', 'db', 'harness', 'repo', 'ci', 'docs', 'deps'],
    ],
    'scope-empty': [2, 'never'],
  },
};
