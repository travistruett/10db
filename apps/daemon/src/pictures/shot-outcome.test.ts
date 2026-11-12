import { describe, expect, it } from 'vitest';
import { shotOutcome, type PageLoad } from './shot-outcome';

const APP = 'http://localhost:3000';
const loaded = (over: Partial<PageLoad> = {}): PageLoad => ({
  error: null,
  landedUrl: 'http://localhost:3000/people',
  status: 200,
  overlayText: null,
  unanswered: false,
  ...over,
});

describe('shotOutcome', () => {
  it.each<[string, string, PageLoad, { outcome: string; reason: string | null }]>([
    ['the page as asked', '/people', loaded(), { outcome: 'clean', reason: null }],
    [
      'the page with its query',
      '/people?tab=all',
      loaded({ landedUrl: 'http://localhost:3000/people?tab=all' }),
      { outcome: 'clean', reason: null },
    ],
    ['a trailing slash the app drops', '/people/', loaded(), { outcome: 'clean', reason: null }],
    [
      'a 404 page of the app is a picture of it',
      '/people',
      loaded({ status: 404 }),
      { outcome: 'clean', reason: null },
    ],
    [
      'a navigation error',
      '/people',
      loaded({ error: 'net::ERR_CONNECTION_REFUSED', landedUrl: null, status: null }),
      { outcome: 'failed', reason: 'net::ERR_CONNECTION_REFUSED' },
    ],
    [
      'nothing answering at the app address: the app is not running, not broken',
      '/people',
      loaded({ error: 'the app did not answer', landedUrl: null, status: null, unanswered: true }),
      { outcome: 'no_answer', reason: 'the app did not answer' },
    ],
    [
      'a timeout',
      '/people',
      loaded({ error: 'Timeout 30000ms exceeded.', status: null }),
      { outcome: 'failed', reason: 'Timeout 30000ms exceeded.' },
    ],
    [
      'no page at all',
      '/people',
      loaded({ landedUrl: null, status: null }),
      { outcome: 'failed', reason: 'the page never loaded' },
    ],
    [
      'a document that answered 500',
      '/people',
      loaded({ status: 500 }),
      { outcome: 'failed', reason: 'the page answered 500' },
    ],
    [
      'a redirect to another port',
      '/people',
      loaded({ landedUrl: 'http://localhost:7433/', status: 403 }),
      { outcome: 'failed', reason: "left the app's address for http://localhost:7433" },
    ],
    [
      'a redirect to 127.0.0.1 for a localhost app',
      '/people',
      loaded({ landedUrl: 'http://127.0.0.1:3000/people' }),
      { outcome: 'failed', reason: "left the app's address for http://127.0.0.1:3000" },
    ],
    [
      'an error page Chromium shows',
      '/people',
      loaded({ landedUrl: 'chrome-error://chromewebdata/' }),
      { outcome: 'failed', reason: "left the app's address for chrome-error://chromewebdata/" },
    ],
    [
      'a redirect to the sign-in page',
      '/people',
      loaded({ landedUrl: 'http://localhost:3000/login?next=/people' }),
      { outcome: 'elsewhere', reason: null },
    ],
    [
      'an overlay over the page',
      '/people',
      loaded({ overlayText: 'Module not found' }),
      { outcome: 'overlay', reason: null },
    ],
    [
      'an overlay on a page that answered 500',
      '/people',
      loaded({ status: 500, overlayText: 'Build Error' }),
      { outcome: 'overlay', reason: null },
    ],
    [
      'an overlay on another page of the app',
      '/people',
      loaded({ landedUrl: 'http://localhost:3000/login', overlayText: 'x' }),
      { outcome: 'elsewhere', reason: null },
    ],
    [
      'a route that is not on the app',
      '//evil.test/x',
      loaded(),
      { outcome: 'failed', reason: '//evil.test/x is not a route on http://localhost:3000' },
    ],
  ])('%s', (_name, route, load, expected) => {
    expect(shotOutcome(APP, route, load)).toEqual(expected);
  });
});
