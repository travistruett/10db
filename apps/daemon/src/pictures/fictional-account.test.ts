import { describe, expect, it } from 'vitest';
import { realAccountProblem } from './fictional-account';

describe('realAccountProblem', () => {
  it.each([
    ['pnpm dev-login --email frontend-e2e@example.test', null],
    ['./bin/login "qa@demo.example" && echo /', null],
    ['login --as bot@example.com --or bot@sub.example.org', null],
    ['login --as seed@app.localhost', null],
    ['login --as nobody@x.invalid', null],
    ['pnpm dev-login', null],
    ['rails runner "puts User.first.login_url"', null],
  ])('accepts %s', (command, problem) => {
    expect(realAccountProblem(command)).toBe(problem);
  });

  it.each([
    ['pnpm dev-login --email ops@ampsio.com', 'ops@ampsio.com'],
    ['./bin/login "Travis@Gmail.COM"', 'Travis@Gmail.COM'],
    ['login --as qa@example.test --then ceo@example.com.evil.io', 'ceo@example.com.evil.io'],
    ['login --as person@test.dev', 'person@test.dev'],
  ])('refuses %s', (command, email) => {
    expect(realAccountProblem(command)).toContain(email);
  });
});
