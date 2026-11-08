import { InboxState } from '@10db/contracts';
import { autoEnableDocker, createTestStore, getProject, seedProject, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { DockerChoice, DockerWhy, raiseDockerOnNote } from './docker-card';
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

function enabled(why: DockerWhy) {
  const project = seedProject(store);
  state.write((ctx) => autoEnableDocker(ctx, project.id));
  return {
    project,
    card: raiseDockerOnNote({ inbox }, { project: { id: project.id, name: project.name }, why }),
  };
}

describe('the note that 10db turned Docker on', () => {
  it('says what it did and why, warns that Docker reaches outside the sandbox, and offers to turn it off', () => {
    const { card, project } = enabled(DockerWhy.Refused);
    expect(card.kind).toBe('flag');
    expect(card.projectId).toBe(project.id);
    expect(card.title).toContain('Docker');
    expect(card.body).toContain('refused');
    expect(card.body).toMatch(/mount any host folder/);
    expect(card.options.map((o) => o.label)).toEqual([DockerChoice.Keep, DockerChoice.TurnOff]);
  });

  it('gives a different reason when the gate was seen to call docker', () => {
    const { card } = enabled(DockerWhy.Called);
    expect(card.body).toContain('calls docker');
    expect(card.body).not.toContain('refused');
  });

  it('leaves one note, however many times it is raised for the project', () => {
    const { card, project } = enabled(DockerWhy.Called);
    const again = raiseDockerOnNote(
      { inbox },
      { project: { id: project.id, name: project.name }, why: DockerWhy.Refused },
    );
    expect(again.id).toBe(card.id);
  });

  it('keeps Docker on when the builder answers Keep it on', () => {
    const { card, project } = enabled(DockerWhy.Refused);
    inbox.answer(card.id, { choice: DockerChoice.Keep });
    expect(getProject(state.db, project.id)).toMatchObject({
      sandboxDocker: true,
      sandboxDockerOptOut: false,
    });
  });

  it('turns Docker off, as a choice 10db keeps, when the builder answers Turn it off', () => {
    const { card, project } = enabled(DockerWhy.Refused);
    const answered = inbox.answer(card.id, { choice: DockerChoice.TurnOff });
    expect(answered.state).toBe(InboxState.Resolved);
    expect(getProject(state.db, project.id)).toMatchObject({
      sandboxDocker: false,
      sandboxDockerOptOut: true,
    });
    expect(state.write((ctx) => autoEnableDocker(ctx, project.id))).toBeNull();
  });
});
