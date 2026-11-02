import { describe, expect, it } from 'vitest';
import { GitNetworkFailure, failureKind } from './network';

describe('failureKind', () => {
  it.each([
    [
      "the 2026-11-02 GitHub error: ' ! [remote rejected] 10db/x -> 10db/x (fatal error in commit_refs_rules)'",
      ' ! [remote rejected] 10db/x -> 10db/x (fatal error in commit_refs_rules)\nerror: failed to push some refs to github.com',
      GitNetworkFailure.ServerError,
    ],
    [
      'an internal error',
      ' ! [remote rejected] a -> a (internal error)\nerror: failed to push some refs',
      GitNetworkFailure.ServerError,
    ],
    [
      'an HTTP 502 from the smart-HTTP transport',
      'error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502\nfatal: the remote end hung up unexpectedly',
      GitNetworkFailure.ServerError,
    ],
    [
      'a 503 on the info/refs request',
      'fatal: unable to access "https://github.com/a/b.git/": The requested URL returned error: 503',
      GitNetworkFailure.ServerError,
    ],
    [
      'a non-fast-forward',
      ' ! [rejected]        a -> a (non-fast-forward)\nerror: failed to push some refs',
      GitNetworkFailure.Rejected,
    ],
    [
      'a fetch-first rejection',
      ' ! [rejected]        a -> a (fetch first)\nerror: failed to push some refs',
      GitNetworkFailure.Rejected,
    ],
    [
      'a protected-branch hook decline',
      ' ! [remote rejected] a -> a (protected branch hook declined)\nerror: failed to push some refs',
      GitNetworkFailure.Rejected,
    ],
    [
      'a remote non-fast-forward',
      ' ! [remote rejected] a -> a (non-fast-forward)\nerror: failed to push some refs',
      GitNetworkFailure.Rejected,
    ],
    [
      'anything else',
      'fatal: Authentication failed for https://github.com/a/b.git/',
      GitNetworkFailure.Failed,
    ],
  ])('reads %s', (_name, detail, kind) => {
    expect(failureKind(detail)).toBe(kind);
  });
});
