import { createTestStore, listPermissionRules, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { allowFoundHosts, listNetworkHosts, removeNetworkHost } from '../permissions';
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

function raise(hosts: readonly string[], projectId = seedProject(store).id) {
  return raiseGateHostCards(
    { state, inbox },
    { projectId, workstreamId: null, command: COMMAND, hosts },
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

    expect(card?.body).toContain('Cargo.lock names index.crates.io as a package registry');
    expect(card?.recommendation).toBe(GateHostChoice.Allow);
  });

  it('says nothing about a file when none names the host, and recommends nothing', () => {
    const [card] = raise(['telemetry.example.com']);
    expect(card?.body).not.toMatch(/names .* as a package registry/);
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

  it.each(['localhost', '127.0.0.1', '*.com', 'not a host'])(
    'raises no card for %s, which a project may not be given',
    (host) => {
      expect(raise([host])).toEqual([]);
    },
  );
});
