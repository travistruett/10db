import { describe, expect, it } from 'vitest';
import { keptRoute } from './kept-route';

// Workbench spec §10 "Which pages": a route an agent reports is loaded only as a page area's route.

describe('keptRoute', () => {
  const AREAS = [
    '/people',
    '/people/[id]',
    '/people/new',
    '/org/:org/teams',
    '/docs/[...slug]',
    '/settings?tab=all',
  ];
  it.each([
    { name: 'the exact route', route: '/people', kept: '/people' },
    { name: 'a parameter as one segment', route: '/people/42', kept: '/people/42' },
    { name: 'a colon parameter', route: '/org/acme/teams', kept: '/org/acme/teams' },
    { name: 'a catch-all as one segment', route: '/docs/intro', kept: '/docs/intro' },
    { name: 'a literal page beside a parameter', route: '/people/new', kept: '/people/new' },
    { name: 'a query dropped', route: '/people/42?tab=notes', kept: '/people/42' },
    { name: 'an acting query dropped', route: '/people/42?action=delete', kept: '/people/42' },
    { name: "the area route's own query kept", route: '/settings', kept: '/settings?tab=all' },
    {
      name: "another query replaced by the area's",
      route: '/settings?tab=x',
      kept: '/settings?tab=all',
    },
    {
      name: 'a value another page uses as a literal at that depth',
      route: '/org/new/teams',
      kept: null,
    },
    {
      name: 'a value of 64 characters',
      route: `/people/${'a'.repeat(64)}`,
      kept: `/people/${'a'.repeat(64)}`,
    },
    { name: 'a value of 65 characters', route: `/people/${'a'.repeat(65)}`, kept: null },
    { name: 'a value with a dot', route: '/people/42.json', kept: null },
    { name: 'a value with an escape', route: '/people/4%32', kept: null },
    { name: 'a deeper path', route: '/people/42/delete', kept: null },
    { name: 'a sibling path', route: '/peoples', kept: null },
    { name: 'another page', route: '/admin', kept: null },
    { name: 'a parameter left empty', route: '/people/', kept: null },
    { name: 'the parameter itself', route: '/people/[id]', kept: null },
    { name: 'a .. segment', route: '/people/..', kept: null },
    { name: 'a .. inside a longer path', route: '/org/../teams', kept: null },
    { name: 'an encoded ..', route: '/people/%2e%2e', kept: null },
    { name: 'an encoded slash', route: '/people/42%2Fdelete', kept: null },
    { name: 'an encoded backslash', route: '/people/42%5Cx', kept: null },
    { name: 'a bad escape', route: '/people/%zz', kept: null },
  ])('$name: $kept', ({ route, kept }) => {
    expect(keptRoute(AREAS, route)).toBe(kept);
  });
});
