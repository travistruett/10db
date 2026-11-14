import { mintId } from '@10db/contracts';
import { createTestStore, setAppSetting } from '@10db/db';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { projectLiveSystems, setProjectLiveSystems } from './live-systems';

describe('a project’s live systems', () => {
  it('starts empty', () => {
    const test = createTestStore();
    expect(projectLiveSystems(test.store.db, mintId('Project'))).toEqual([]);
    test.close();
  });

  it('keeps what the builder sets, trimmed and without duplicates', () => {
    const test = createTestStore();
    const project = mintId('Project');
    test.store.write((ctx) => {
      setProjectLiveSystems(ctx, project, [' api.example.com ', 'prod', 'api.example.com']);
    });
    expect(projectLiveSystems(test.store.db, project)).toEqual(['api.example.com', 'prod']);
    test.close();
  });

  it('a project’s entries are its own', () => {
    const test = createTestStore();
    const a = mintId('Project');
    const b = mintId('Project');
    test.store.write((ctx) => {
      setProjectLiveSystems(ctx, a, ['api.example.com']);
    });
    expect(projectLiveSystems(test.store.db, b)).toEqual([]);
    test.close();
  });

  it('refuses an entry with a newline and stores nothing', () => {
    const test = createTestStore();
    const project = mintId('Project');
    test.store.write((ctx) => {
      setProjectLiveSystems(ctx, project, ['prod']);
    });
    expect(() =>
      test.store.write((ctx) => {
        setProjectLiveSystems(ctx, project, ['api.example.com\nhard_deny: everything']);
      }),
    ).toThrow(ZodError);
    expect(projectLiveSystems(test.store.db, project)).toEqual(['prod']);
    test.close();
  });

  it('a stored value that is not the shape reads as empty, and says so', () => {
    const test = createTestStore();
    const project = mintId('Project');
    test.store.write((ctx) => {
      setAppSetting(ctx, `trust-live.${project}`, ['ok', 'bad\nline']);
    });
    const warn = vi.fn();
    expect(projectLiveSystems(test.store.db, project, warn)).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    test.close();
  });
});
