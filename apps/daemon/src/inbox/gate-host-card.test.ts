import type { ProjectId } from '@10db/contracts';
import { createTestStore, listPermissionRules, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { allowFoundHosts, listNetworkHosts, removeNetworkHost } from '../permissions';
import { BlockedRun } from '../verify';
import { GateHostChoice, raiseGateHostCards } from './gate-host-card';
import { createInboxService, type InboxService } from './service';

let close: () => void;
let store: Store;
let state: StateStore;
let inbox: InboxService;
beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  inbox = createInboxService({ state, onParkedAnswer: () => undefined });
});
afterEach(() => {
  close();
});

const COMMAND = 'cargo test --workspace';
const INSTALL = 'pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile';

function raise(hosts: readonly string[], projectId = seedProject(store).id) {
  return raiseGateHostCards(
    { state, inbox },
    { projectId, run: BlockedRun.Gate, command: COMMAND, hosts },
  );
}

describe('a gate blocked from a host', () => {
  it('raises one card per host, naming the host and the gate command, with Allow for the project', () => {
    const cards = raise(['index.crates.io', 'static.crates.io']);
    expect(cards.map((c) => c.title)).toEqual([
      'Allow network access to index.crates.io?',
      'Allow network access to static.crates.io?',
    ]);
    const [card] = cards;
    expect(card?.kind).toBe('flag');
    expect(card?.body).toContain('index.crates.io');
    expect(card?.body).toContain(COMMAND);
    expect(card?.options.map((o) => o.label)).toEqual([GateHostChoice.Allow, GateHostChoice.Later]);
    expect(card?.recommendation).toBeNull();
  });

  it('names the file that names the host, and recommends Allow', () => {
    const project = seedProject(store);
    allowFoundHosts(state, project.id, [{ host: 'index.crates.io', file: 'Cargo.lock' }]);
    // The builder removed the host after setup; the file still names it.
    removeNetworkHost(state, project.id, 'index.crates.io');
    expect(listNetworkHosts(state.db, project.id)).toEqual([]);

    const [card] = raise(['index.crates.io'], project.id);

    expect(card?.body).toContain("The project's Cargo.lock needs index.crates.io");
    expect(card?.recommendation).toBe(GateHostChoice.Allow);
  });

  it('says a toolchain file needs its host, without calling the file a registry', () => {
    const project = seedProject(store);
    allowFoundHosts(state, project.id, [{ host: 'nodejs.org', file: '.nvmrc' }]);
    removeNetworkHost(state, project.id, 'nodejs.org');

    const [card] = raise(['nodejs.org'], project.id);

    expect(card?.body).toContain("The project's .nvmrc needs nodejs.org");
    expect(card?.body).not.toMatch(/registry|names nodejs\.org/);
  });

  it('says nothing about a file when none names the host, and recommends nothing', () => {
    const [card] = raise(['telemetry.example.com']);
    expect(card?.body).not.toContain('needs');
    expect(card?.recommendation).toBeNull();
  });

  it('allows the host for the project when the builder answers Allow for the project', () => {
    const project = seedProject(store);
    const [card] = raise(['index.crates.io'], project.id);
    if (!card) throw new Error('no card');

    inbox.answer(card.id, { choice: GateHostChoice.Allow });

    expect(listNetworkHosts(state.db, project.id).map((h) => [h.host, h.source])).toEqual([
      ['index.crates.io', { kind: 'card' }],
    ]);
    expect(listPermissionRules(state.db, project.id, null).map((r) => r.sourceInboxId)).toEqual([
      card.id,
    ]);
  });

  it('allows nothing when the builder answers Not now', () => {
    const project = seedProject(store);
    const [card] = raise(['index.crates.io'], project.id);
    if (!card) throw new Error('no card');

    inbox.answer(card.id, { choice: GateHostChoice.Later });

    expect(listNetworkHosts(state.db, project.id)).toEqual([]);
  });

  it('raises no second card for a host already asked about, and none for a host already allowed', () => {
    const project = seedProject(store);
    allowFoundHosts(state, project.id, [{ host: 'static.crates.io', file: 'Cargo.lock' }]);
    const first = raise(['index.crates.io', 'static.crates.io'], project.id);
    const again = raise(['index.crates.io'], project.id);
    expect(first.map((c) => c.title)).toEqual(['Allow network access to index.crates.io?']);
    expect(again.map((c) => c.id)).toEqual(first.map((c) => c.id));
  });

  it.each(['localhost', '127.0.0.1', '*.com', 'not a host', '*.example.com', '*.s3.amazonaws.com'])(
    'raises no card for %s, which a project may not be given',
    (host) => {
      expect(raise([host])).toEqual([]);
    },
  );
});

describe("10db's install of a worktree's packages blocked from a host", () => {
  function raiseForInstall(hosts: readonly string[], projectId: ProjectId) {
    return raiseGateHostCards(
      { state, inbox },
      { projectId, run: BlockedRun.Install, command: INSTALL, hosts },
    );
  }

  it('names the install, its command and the file that needs the host, and never the gate', () => {
    const project = seedProject(store);
    allowFoundHosts(state, project.id, [{ host: 'registry.npmjs.org', file: 'pnpm-lock.yaml' }]);
    removeNetworkHost(state, project.id, 'registry.npmjs.org');

    const [card] = raiseForInstall(['registry.npmjs.org'], project.id);

    expect(card?.title).toBe('Allow network access to registry.npmjs.org?');
    expect(card?.body).toContain(
      "The sandbox blocked 10db's install of a worktree's packages from reaching registry.npmjs.org, and the install failed.",
    );
    expect(card?.body).toContain(`Install: ${INSTALL}`);
    expect(card?.body).toContain("The project's pnpm-lock.yaml needs registry.npmjs.org");
    expect(card?.body).toContain('then try again.');
    expect(card?.options.map((o) => o.label)).toEqual([GateHostChoice.Allow, GateHostChoice.Later]);
    expect(card?.recommendation).toBe(GateHostChoice.Allow);
    const words = [card?.body, ...(card?.options ?? []).map((o) => o.description)].join('\n');
    expect(words).not.toMatch(/\bgate\b/i);
  });

  it('shares one card per host with a gate blocked from the same host, and Allow allows it', () => {
    const project = seedProject(store);
    const [installCard] = raiseForInstall(['registry.npmjs.org'], project.id);
    const [gateCard] = raise(['registry.npmjs.org'], project.id);
    if (!installCard) throw new Error('no card');
    expect(gateCard?.id).toBe(installCard.id);

    inbox.answer(installCard.id, { choice: GateHostChoice.Allow });

    expect(listNetworkHosts(state.db, project.id).map((h) => h.host)).toEqual([
      'registry.npmjs.org',
    ]);
  });
});
