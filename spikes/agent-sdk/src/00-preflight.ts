// Checks the helpers without calling a model: the env allowlist, the claude binary, and the fixture repo.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountInfo, SDKSystemMessage } from '@anthropic-ai/claude-agent-sdk';
import { assertCleanEnv, buildChildEnv } from './env.ts';
import { CLAUDE } from './claude.ts';
import { makeFixtureRepo } from './fixture-repo.ts';
import { check, finish, info } from './report.ts';
import { assertSubscription } from './session.ts';

const dirty = {
  HOME: '/h/x',
  PATH: '/usr/bin',
  USER: 'x',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet',
  AWS_PROFILE: 'example-profile',
  AWS_REGION: 'us-east-1',
  ANTHROPIC_API_KEY: 'sk-ant-should-never-pass',
  ANTHROPIC_MODEL: 'x',
  CLAUDECODE: '1',
  CLAUDE_AGENT_SDK_VERSION: 'x',
};
const env = buildChildEnv(dirty);
check('env strips provider and billing vars', Object.keys(env).every((k) => !/^(AWS_|ANTHROPIC_|CLAUDECODE)/.test(k)) && !('CLAUDE_CODE_USE_BEDROCK' in env), JSON.stringify(Object.keys(env)));
check('env keeps the allowlist', env['HOME'] === '/h/x' && env['PATH'] === '/usr/bin' && env['USER'] === 'x', 'HOME, PATH, USER present');
check('env sets the client app id', env['CLAUDE_AGENT_SDK_CLIENT_APP'] === '10db-spikes/0.0.0', String(env['CLAUDE_AGENT_SDK_CLIENT_APP']));
let threw = false;
try {
  assertCleanEnv({ ...env, AWS_PROFILE: 'x' });
} catch {
  threw = true;
}
check('assertCleanEnv rejects a leaked var', threw, 'AWS_PROFILE injected after build');
check('claude resolved', existsSync(CLAUDE.path), CLAUDE.path);
check('claude version readable', /^\d+\.\d+\.\d+/.test(CLAUDE.version), CLAUDE.version);
const repo = makeFixtureRepo({ 'notes.txt': 'hello\n' });
const log = execFileSync('git', ['-C', repo, 'log', '--oneline'], { encoding: 'utf8' });
check('fixture repo has one commit', log.trim().split('\n').length === 1, log.trim());
check('fixture repo has the extra file', existsSync(join(repo, 'notes.txt')), repo);
const billingRejects = (keySource: string, account: AccountInfo | undefined): boolean => {
  try {
    assertSubscription({ apiKeySource: keySource as SDKSystemMessage['apiKeySource'] }, account);
    return false;
  } catch (error) {
    return error instanceof Error && error.message.startsWith('BILLING');
  }
};
const max: AccountInfo = { apiProvider: 'firstParty', subscriptionType: 'max' };
check('billing accepts the subscription login', !billingRejects('none', max), 'none + firstParty + max');
check('billing rejects Bedrock (also reports none)', billingRejects('none', { apiProvider: 'bedrock' }), 'none + bedrock');
check('billing rejects a Console API-key login', billingRejects('/login managed key', { apiProvider: 'firstParty' }), '/login managed key');
check('billing rejects ANTHROPIC_API_KEY', billingRejects('ANTHROPIC_API_KEY', max), 'ANTHROPIC_API_KEY');
check('billing rejects a missing account', billingRejects('none', undefined), 'accountInfo timed out');
info('parent env has Bedrock flag', 'CLAUDE_CODE_USE_BEDROCK' in process.env);
finish();
