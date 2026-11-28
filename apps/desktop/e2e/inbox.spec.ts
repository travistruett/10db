import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  chromium,
  expect,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';
import { z } from 'zod';
import { daemonUrl } from './daemon-url';
import { E2E_DATA, E2E_DIR } from './paths';
import { test } from './routed-test';
import { auth, createProject } from './shape-project';
import { freeLoopbackPort, startTlsStandIn, type TlsStandIn } from './tls-standin';

// Core flow 3: the builder answers Inbox cards from the keyboard. The questions are written into the
// idle daemon's database, into a project of their own, and answered again when the spec ends so no
// later spec reads them. The last test answers a card from a phone paired through the share listener: a
// stand-in for `tailscale serve` (tls-standin.ts) and a fake Tailscale CLI (fake-tailscale.mjs) stand between
// the phone's Chromium and the daemon.

const PROJECT_NAME = 'e2e-inbox';

const OpenCards = z.array(
  z.looseObject({
    id: z.string(),
    projectId: z.string(),
    options: z.array(z.looseObject({ label: z.string() })),
  }),
);

test.describe.configure({ mode: 'serial' });

let projectId = '';
let oomProjectId = '';
/** A guardrail file the project's repository commits, which a lane's write changes in the stray-write check. */
const WORKFLOW = '.github/workflows/ci.yml';

/** Answers every card this spec left open, so later specs read no stray cards. */
async function resolveOwnCards(request: APIRequestContext): Promise<void> {
  const response = await request.get(`${daemonUrl}/inbox?state=OPEN`, {
    headers: auth,
    maxRetries: 2,
  });
  const own = OpenCards.parse(await response.json()).filter(
    (card) => card.projectId === projectId || card.projectId === oomProjectId,
  );
  for (const card of own) {
    // An out-of-moves card's first answer starts more work; Drop It ends it.
    const choice = card.options.find((option) => option.label === 'Drop It') ?? card.options[0];
    const answered = await request.post(`${daemonUrl}/inbox/${card.id}/answer`, {
      headers: auth,
      // A flag closes on any word; a question needs one of its options, and records nothing.
      data: choice === undefined ? { choice: 'dismissed' } : { choice: choice.label, record: null },
    });
    expect(answered.ok()).toBe(true);
  }
}

const SystemAnswer = z.looseObject({
  tools: z.array(
    z.looseObject({
      name: z.string(),
      path: z.string().nullable(),
      version: z.string().nullable(),
    }),
  ),
});

/**
 * The rail's badge counts 10db's own cards, one for each tool the system check does not find, and the check's
 * answer changes as it settles. With every tool found, the badge is the daemon's count.
 */
async function toolsAreInstalled(page: Page): Promise<void> {
  await page.route(`${daemonUrl}/system*`, async (route) => {
    const response = await route.fetch({ maxRetries: 2 });
    const body = SystemAnswer.parse(await response.json());
    for (const tool of body.tools) {
      tool.path ??= `/usr/local/bin/${tool.name}`;
      tool.version ??= '1.0.0';
    }
    await route.fulfill({ response, json: body });
  });
}

const rowsOf = (page: Page) => page.locator('[data-inbox-row]');
const inboxUrl = (search: string) => `/inbox?project=${projectId}${search}`;

test.beforeAll(async ({ request }) => {
  projectId = await createProject(
    request,
    PROJECT_NAME,
    [{ name: 'greeting', globs: ['src/greeting/**'] }],
    { [WORKFLOW]: 'on: push\n' },
  );
});

test.afterAll(async ({ request }) => {
  try {
    await resolveOwnCards(request);
  } finally {
    await stopSharing(request);
  }
});

test('answering a question with a digit and Enter selects the next row and lowers the badge', async ({
  page,
}) => {
  for (const title of ['Keep the cache?', 'Retry the sync?', 'Show the banner?']) {
    execFileSync(
      'pnpm',
      [
        'exec',
        'tsx',
        'scripts/seed-question-card.ts',
        resolve(E2E_DATA, '10db.sqlite'),
        JSON.stringify({
          projectId,
          title,
          body: 'Seeded for the answer check.',
          options: [
            { label: 'Yes', description: '' },
            { label: 'No', description: '' },
          ],
        }),
      ],
      { cwd: resolve(import.meta.dirname, '../../daemon'), stdio: 'inherit' },
    );
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await toolsAreInstalled(page);
  await page.goto(inboxUrl('&kind=question'));
  await expect(rowsOf(page)).toHaveCount(3);
  const badge = page.getByRole('navigation').getByRole('link', { name: /^Inbox/ });
  // The badge reads its number twice, once for the eye and once for assistive tech: the phrase is the whole count.
  const count = async (): Promise<number> =>
    Number(
      /^(\d+) open cards?/i.exec(await badge.getByText(/open cards?/i).innerText())?.[1] ?? '0',
    );
  // The badge also counts 10db's own cards, which arrive as its system check settles: read it once it has.
  let before = await count();
  await expect
    .poll(
      async () => {
        const previous = before;
        before = await count();
        return before === previous;
      },
      { intervals: [1500] },
    )
    .toBe(true);
  expect(before).toBeGreaterThanOrEqual(3);
  await expect(rowsOf(page).first()).toHaveAttribute('aria-selected', 'true');
  // Open holds the builder's cards, and each says which of the seven things it is.
  await expect(page.getByTestId('card-owns')).toContainText('Yours: Product and Taste');
  await page.keyboard.press('1');
  await page.keyboard.press('Enter');
  await expect(rowsOf(page)).toHaveCount(2);
  await expect(rowsOf(page).first()).toHaveAttribute('aria-selected', 'true');
  await expect(rowsOf(page).first()).toContainText('Retry the sync?');
  await expect.poll(count).toBe(before - 1);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('an acceptance card shows what it could not confirm and what Accept Without Proof does', async ({
  page,
}) => {
  const title = 'Check these criteria: Greet by name';
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/seed-question-card.ts',
      resolve(E2E_DATA, '10db.sqlite'),
      JSON.stringify({
        projectId,
        title,
        body: 'Seeded for the acceptance check.',
        options: [
          { label: 'accept', description: 'The work is right as it is' },
          { label: 'send_back', description: 'Send it back with a note' },
        ],
        acceptance: {
          criteria: [
            {
              criterion: 'The greeting names the user',
              verdict: 'not_met',
              note: 'read as not met',
            },
            { criterion: 'It falls back to "there"', verdict: 'unclear', note: 'read as unclear' },
            { criterion: 'It is one line', verdict: 'met', note: 'read as met' },
          ],
          unasked: 'It also logs the name.',
          sentBack: false,
        },
      }),
    ],
    { cwd: resolve(import.meta.dirname, '../../daemon'), stdio: 'inherit' },
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(inboxUrl('&kind=acceptance'));
  await rowsOf(page).filter({ hasText: title }).click();
  // On the Mac's pane the fold starts open under its counts; the met criterion is not listed.
  await expect(page.getByRole('button', { name: '2 unconfirmed, 1 extra' })).toBeVisible();
  await expect(page.getByText('The greeting names the user')).toBeVisible();
  await expect(page.getByText('It is one line')).toHaveCount(0);
  await expect(
    page.getByText(
      'Already shipped. Accept Without Proof changes nothing. Send Back files a fix task.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: /^Accept Without Proof/ }).click();
  await expect(rowsOf(page).filter({ hasText: title })).toHaveCount(0);
});

test('a lane edit to a guardrail file shows its diff, and Revert puts the committed file back', async ({
  page,
}) => {
  const root = join(E2E_DIR, `${PROJECT_NAME}-repo`);
  const file = join(root, WORKFLOW);
  writeFileSync(file, 'on: pull_request\n');
  const title = 'A lane edited your CI workflows';
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/seed-question-card.ts',
      resolve(E2E_DATA, '10db.sqlite'),
      JSON.stringify({
        projectId,
        title,
        body: WORKFLOW,
        options: [
          { label: 'Keep', description: 'Stop flagging this exact content at this path' },
          { label: 'Revert', description: 'Put back the committed file' },
        ],
        stray: {
          root,
          path: WORKFLOW,
          diff: {
            shown: 'text',
            text: `--- a/${WORKFLOW}\n+++ b/${WORKFLOW}\n@@ -1 +1 @@\n-on: push\n+on: pull_request`,
            cut: false,
            lines: 5,
            isNew: false,
          },
        },
      }),
    ],
    { cwd: resolve(import.meta.dirname, '../../daemon'), stdio: 'inherit' },
  );
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(inboxUrl('&kind=flag'));
  await rowsOf(page).filter({ hasText: title }).click();
  await expect(page.getByLabel('Diff')).toContainText('+on: pull_request');
  await page.getByRole('radio', { name: /^Revert/ }).click();
  await page.getByRole('button', { name: /^Send Answer/ }).click();
  await expect(rowsOf(page).filter({ hasText: title })).toHaveCount(0);
  await expect.poll(() => readFileSync(file, 'utf8')).toBe('on: push\n');
});

const OOM_PROJECT = 'e2e-out-of-moves';
const OOM_REPO = join(E2E_DIR, 'out-of-moves-repo');
const OOM_BRANCH = '10db/out-of-moves-e2e';
const OOM_BATCH = 'Greet the e2e';
const OOM_TASK = 'Greet in the e2e';
const OOM_CARD = `Out of moves: 1 test fails in test · ${OOM_BATCH}`;
/** The fix task 10db files for the gate; `script-book.json` holds its sessions under this title. */
const OOM_FIX = `Fix the gate: 1 test fails in test · ${OOM_BATCH}`;

const Batches = z.array(z.looseObject({ id: z.string(), title: z.string(), state: z.string() }));
const TaskRows = z.array(z.looseObject({ title: z.string(), workstreamId: z.string().optional() }));

/**
 * The out-of-moves project's repository: a gate that always fails one test in vitest's words, and the
 * batch's branch, checked out, whose one commit adds that test's file, so the failure is the batch's own.
 * Answers the commit the branch was cut from.
 */
function createOutOfMovesRepository(): string {
  mkdirSync(OOM_REPO, { recursive: true });
  const globalConfig = join(E2E_DIR, 'out-of-moves-gitconfig');
  writeFileSync(globalConfig, '');
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
  };
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: OOM_REPO, env, encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  git('config', 'maintenance.auto', 'false');
  git('config', 'gc.auto', '0');
  git('config', 'receive.autogc', 'false');
  git('config', 'user.email', 'e2e@10db.invalid');
  git('config', 'user.name', '10db e2e');
  git('config', 'commit.gpgsign', 'false');
  // The ship reruns a failing test file with `pnpm exec vitest`, which on a runner that has vitest on its
  // PATH writes its cache under `node_modules`; untracked, that would make the checkout dirty before the
  // second ship and raise the dirty-checkout card in place of the out-of-moves one.
  writeFileSync(join(OOM_REPO, '.gitignore'), '.gate/\nnode_modules/\n');
  writeFileSync(
    join(OOM_REPO, 'gate.sh'),
    [
      'mkdir -p .gate',
      "printf '%s\\n' ' FAIL  daemon  src/greeting/hello.test.ts > greets' 'AssertionError: expected 1 to be 2' > .gate/test.log",
      "echo 'FAILED test: pnpm test (log .gate/test.log)'",
      "echo 'GATE FAIL: test — logs in .gate/; test 1s (1s)'",
      'exit 1',
      '',
    ].join('\n'),
  );
  git('add', '.gitignore', 'gate.sh');
  git('commit', '-m', 'Initial commit');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-b', OOM_BRANCH);
  mkdirSync(join(OOM_REPO, 'src/greeting'), { recursive: true });
  writeFileSync(join(OOM_REPO, 'src/greeting/hello.test.ts'), "it('greets', () => {});\n");
  git('add', 'src/greeting/hello.test.ts');
  git('commit', '-m', 'Add the greeting test');
  return base;
}

/**
 * A pull-request project whose batch's task is done, seeded the way a start and a finished run leave it:
 * starting a real batch needs a GitHub origin and a signed-in gh. Each implement step's check passes; only
 * the ship gate fails.
 */
async function seedOutOfMovesProject(request: APIRequestContext): Promise<string> {
  const baseSha = createOutOfMovesRepository();
  const created = await request.post(`${daemonUrl}/projects`, {
    headers: auth,
    data: {
      name: OOM_PROJECT,
      repoPath: OOM_REPO,
      gateCommand: 'sh gate.sh',
      changedCheckCommand: 'true',
      areas: [{ name: 'greeting', globs: ['src/greeting/**'] }],
      handoffPct: 40,
      nudgePct: 50,
      delivery: 'pull_request',
      workspaceMode: 'shared',
    },
  });
  expect(created.ok()).toBe(true);
  const id = z.looseObject({ id: z.string() }).parse(await created.json()).id;
  const task = await request.post(`${daemonUrl}/projects/${id}/tasks`, {
    headers: auth,
    data: { title: OOM_TASK, acceptanceCriteria: ['it greets'], areas: ['greeting'] },
  });
  expect(task.ok()).toBe(true);
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/seed-worktree-batches.ts',
      resolve(E2E_DATA, '10db.sqlite'),
      JSON.stringify({
        projectId: id,
        worktreeRoot: E2E_DIR,
        open: [
          {
            taskId: z.looseObject({ id: z.string() }).parse(await task.json()).id,
            title: OOM_BATCH,
            state: 'DONE',
            worktree: false,
            branch: OOM_BRANCH,
            baseSha,
            repo: 'e2e/out-of-moves',
          },
        ],
        shipped: [],
      }),
    ],
    { cwd: resolve(import.meta.dirname, '../../daemon'), stdio: 'inherit' },
  );
  return id;
}

test('a ship gate out of moves asks Spend More Attempts, Change the Task or Drop It, and More files another fix', async ({
  page,
  request,
}) => {
  // Two fix runs on the fake adapter and three gate runs.
  test.setTimeout(240_000);
  oomProjectId = await seedOutOfMovesProject(request);
  const batch = async () => {
    const response = await request.get(`${daemonUrl}/projects/${oomProjectId}/batches`, {
      headers: auth,
      maxRetries: 2,
    });
    const found = Batches.parse(await response.json()).find((b) => b.title === OOM_BATCH);
    if (!found) throw new Error(`no batch "${OOM_BATCH}"`);
    return found;
  };
  const fixes = async () => {
    const response = await request.get(`${daemonUrl}/projects/${oomProjectId}/tasks`, {
      headers: auth,
      maxRetries: 2,
    });
    return TaskRows.parse(await response.json()).filter((t) => t.title === OOM_FIX);
  };
  const { id: batchId } = await batch();
  // The gate fails in the batch's own test: 10db files a fix task and the batch reopens. The fix runs,
  // the gate fails the same way, and 10db stops with one card.
  const shipped = await request.post(`${daemonUrl}/batches/${batchId}/ship`, { headers: auth });
  expect(shipped.ok()).toBe(true);
  await expect.poll(async () => (await batch()).state, { timeout: 180_000 }).toBe('FAILED');
  expect(await fixes()).toHaveLength(1);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/inbox?project=${oomProjectId}`);
  const row = rowsOf(page).filter({ hasText: OOM_CARD });
  await row.click();
  // Exact: the card body repeats this line and adds the gate's note that the project has no origin to fetch.
  await expect(
    page.getByText('The same tests failed again after the fix.', { exact: true }),
  ).toBeVisible();
  // The answers are the card's options, drawn as radios (each name starts with its key hint), sent by Send Answer.
  await expect(page.getByRole('radio', { name: /Change the Task/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Drop It/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Abandon', exact: true })).toHaveCount(0);
  await page.getByRole('radio', { name: /Spend More Attempts/ }).click();
  await page.getByRole('button', { name: /^Send Answer/ }).click();
  // The gate runs again and fails as before; with more allowed, a second fix task reopens the batch.
  await expect.poll(fixes, { timeout: 60_000 }).toHaveLength(2);

  // The second fix would run and fail the gate again: it is cancelled and the batch abandoned.
  for (const fix of await fixes()) {
    if (fix.workstreamId !== undefined)
      await request.post(`${daemonUrl}/workstreams/${fix.workstreamId}/cancel`, { headers: auth });
  }
  await expect
    .poll(
      async () =>
        (await request.post(`${daemonUrl}/batches/${batchId}/abandon`, { headers: auth })).ok() ||
        (await batch()).state === 'ABANDONED',
      { timeout: 30_000 },
    )
    .toBe(true);
});

const Shared = z.looseObject({ state: z.string() });

/** Writes one open question card into the project, as a lane's `ask_human` would. */
function seedQuestion(title: string): void {
  execFileSync(
    'pnpm',
    [
      'exec',
      'tsx',
      'scripts/seed-question-card.ts',
      resolve(E2E_DATA, '10db.sqlite'),
      JSON.stringify({
        projectId,
        title,
        body: 'Seeded for the phone check.',
        options: [
          { label: 'Yes', description: '' },
          { label: 'No', description: '' },
        ],
      }),
    ],
    { cwd: resolve(import.meta.dirname, '../../daemon'), stdio: 'inherit' },
  );
}

const DeviceIds = z.array(z.looseObject({ id: z.string() }));

/**
 * Turns sharing off and revokes every device. It runs in afterAll whatever the phone test did, so a failure
 * halfway never leaves the share listener on for the specs after it; it tolerates a reply that isn't what it
 * expects, so the cleanup never hides the failure that came first.
 */
async function stopSharing(request: APIRequestContext): Promise<void> {
  const list = await request.get(`${daemonUrl}/devices`, { headers: auth, maxRetries: 2 });
  const devices = DeviceIds.safeParse(list.ok() ? await list.json().catch(() => null) : null);
  for (const device of devices.success ? devices.data : []) {
    await request.delete(`${daemonUrl}/devices/${device.id}`, { headers: auth });
  }
  await request.put(`${daemonUrl}/sharing`, { headers: auth, data: { enabled: false } });
}

test("a card is answered from a phone paired from the bar's Remote access card", async ({
  page,
  request,
}) => {
  const fqdn = 'mac.e2e.ts.net';
  const title = 'Ship the phone Inbox?';
  // Left open: the Mac's page shows it once it has loaded, which is when "the answered card is gone" means something.
  const stays = 'Hold the phone card for later?';
  seedQuestion(title);
  seedQuestion(stays);

  let standIn: TlsStandIn | undefined;
  let browser: Browser | undefined;
  try {
    // Sharing on, as the Remote Access page does: the name's certificate asked for, then Share.
    const sharePort = await freeLoopbackPort();
    expect((await request.post(`${daemonUrl}/sharing/certificate`, { headers: auth })).ok()).toBe(
      true,
    );
    const shared = await request.put(`${daemonUrl}/sharing`, {
      headers: auth,
      data: { enabled: true, port: sharePort },
    });
    expect(shared.ok()).toBe(true);
    await expect
      .poll(
        async () =>
          Shared.parse(
            await (
              await request.get(`${daemonUrl}/sharing`, { headers: auth, maxRetries: 2 })
            ).json(),
          ).state,
      )
      .toBe('ready');
    standIn = await startTlsStandIn({ fqdn, sharePort, login: 'e2e@example.com' });
    browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${fqdn} 127.0.0.1`] });

    await page.setViewportSize({ width: 1280, height: 900 });
    await toolsAreInstalled(page);
    // Pairing starts from the bar's Remote access card, which says what a paired phone can do.
    await page.goto(inboxUrl(''));
    await page.getByRole('button', { name: 'Remote access: on' }).click();
    const remoteCard = page.getByRole('group', { name: 'Remote access' });
    await expect(remoteCard.getByText(/answer the Inbox/)).toBeVisible();
    await remoteCard.getByRole('button', { name: /^Pair (a|another) phone$/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Pair a Device' });
    // The pointer moves onto the dialog, as a person's does to read the code: the card closes, the dialog stays.
    await dialog.hover();
    await expect(remoteCard).toBeHidden();
    const label = await dialog.getByLabel(/^Pairing code /).getAttribute('aria-label');
    const code = (label ?? '').replace(/^Pairing code /, '').replace(' ', '');
    expect(code).toMatch(/^[0-9A-Z]{8}$/);

    const phone = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
      ignoreHTTPSErrors: true,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
      // The test says nothing about the worker, and one would cache the page between steps.
      serviceWorkers: 'block',
    });
    phone.setDefaultTimeout(20_000);
    // The runner traces this context too (`trace: retain-on-failure`), so a failure keeps the phone's trace.
    const mobile = await phone.newPage();
    await mobile.goto(`https://${fqdn}:${String(standIn.port)}/app/pair#code=${code}`);
    await expect(mobile.getByRole('heading', { name: /^Paired with/ })).toBeVisible();
    // Notifications come first once paired; with the worker blocked here, the page says why it can't offer them.
    await expect(mobile.getByText(/This browser can’t show notifications here/)).toBeVisible();
    // The dialog on the Mac says who paired, then closes, and the card lists the phone.
    await expect(dialog).toBeHidden();
    await page.getByRole('button', { name: 'Remote access: on' }).click();
    await expect(remoteCard.getByLabel('Paired devices')).toBeVisible();
    await page.keyboard.press('Escape');
    await mobile.getByRole('link', { name: 'Open Inbox' }).click();
    // The row in the list sheet, not the card's own title, which may already be drawn under the sheet.
    await mobile.getByRole('listbox', { name: 'Inbox' }).getByText(title).click();
    await mobile.getByRole('radio', { name: /Yes/ }).click();
    await mobile.getByRole('button', { name: /^Send Answer/ }).click();
    await expect(mobile.getByText(title)).toHaveCount(0);
    // The Mac sees the same: once its list has loaded (the card left open is in it), the answered card is not.
    await page.goto(inboxUrl('&kind=question'));
    await expect(page.getByText(stays).first()).toBeVisible();
    await expect(page.getByText(title)).toHaveCount(0);
    // The Mac goes out of the phone's reach: once it has failed for 10 s, the phone says so and what to check.
    await standIn.close();
    standIn = undefined;
    await expect(mobile.getByText("Can't reach your Mac")).toBeVisible({ timeout: 30_000 });
  } finally {
    await browser?.close();
    await standIn?.close();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});
