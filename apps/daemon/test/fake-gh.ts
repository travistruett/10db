import { readFileSync } from 'node:fs';
import {
  GhError,
  PrState,
  summariseChecks,
  type CheckRollupEntry,
  type Gh,
  type PullRequest,
  type PullRequestStatus,
} from '../src/github';

export type GhMethod =
  | 'authStatus'
  | 'authLogin'
  | 'repoView'
  | 'repoAllowsAutoMerge'
  | 'prView'
  | 'prStatus'
  | 'prCreate'
  | 'prAutoMerge';
export interface PrCreateCall {
  readonly repo: string;
  readonly base: string;
  readonly head: string;
  readonly title: string;
}

/** gh at the Gh interface: an in-memory GitHub with one repository. */
export class FakeGh implements Gh {
  auth: 'ok' | 'signed_out' | 'not_installed' = 'ok';
  repo = 'acme/widgets';
  /** Whether the repository allows auto-merge, as GitHub's setting does. */
  autoMergeAllowed = true;
  /** The pull requests auto-merge was turned on for, in order. */
  readonly autoMerged: string[] = [];
  /** One error per method, thrown by its next call only. */
  readonly failNext = new Map<GhMethod, GhError>();
  /**
   * Status reads of these pull request urls fail with their error, call after call, until removed:
   * a pull request gh can't read while it reads the others.
   */
  readonly failRead = new Map<string, GhError>();
  readonly calls: { readonly method: GhMethod; readonly args: unknown }[] = [];
  private readonly byRef = new Map<
    string,
    {
      pr: { url: string; state: PrState };
      body: string;
      create: PrCreateCall | null;
      rollup: readonly CheckRollupEntry[];
    }
  >();
  private next = 1;

  /** `fails` is this call's own failure, after gh's: a signed-out gh fails every call the same way. */
  private call<T>(method: GhMethod, args: unknown, answer: () => T, fails?: GhError): Promise<T> {
    this.calls.push({ method, args });
    const queued = this.failNext.get(method);
    if (queued) {
      this.failNext.delete(method);
      return Promise.reject(queued);
    }
    if (this.auth === 'not_installed')
      return Promise.reject(new GhError('not_installed', 'gh is not installed'));
    if (this.auth === 'signed_out')
      return Promise.reject(new GhError('signed_out', 'gh is not signed in'));
    if (fails) return Promise.reject(fails);
    return Promise.resolve(answer());
  }

  // Each method omits the GhCall it ignores; a shorter parameter list still implements Gh.
  authStatus(): Promise<void> {
    return this.call('authStatus', {}, () => undefined);
  }

  authLogin(): Promise<string | null> {
    if (this.auth === 'signed_out') {
      this.calls.push({ method: 'authLogin', args: {} });
      return Promise.resolve(null);
    }
    return this.call('authLogin', {}, () => 'octocat');
  }

  repoView(): Promise<string> {
    return this.call('repoView', {}, () => this.repo);
  }

  prView(input: { readonly repo: string; readonly ref: string }): Promise<PullRequest | null> {
    return this.call('prView', input, () => {
      const found = this.byRef.get(input.ref);
      return found ? { ...found.pr } : null;
    });
  }

  prStatus(input: {
    readonly repo: string;
    readonly ref: string;
  }): Promise<PullRequestStatus | null> {
    return this.call(
      'prStatus',
      input,
      () => {
        const found = this.byRef.get(input.ref);
        return found ? { ...found.pr, ...summariseChecks(found.rollup) } : null;
      },
      this.failRead.get(input.ref),
    );
  }

  prCreate(input: {
    readonly repo: string;
    readonly base: string;
    readonly head: string;
    readonly title: string;
    readonly bodyFile: string;
  }): Promise<string> {
    return this.call('prCreate', input, () => {
      const create = { repo: input.repo, base: input.base, head: input.head, title: input.title };
      return this.add(input.head, PrState.Open, readFileSync(input.bodyFile, 'utf8'), create);
    });
  }

  repoAllowsAutoMerge(): Promise<boolean> {
    return this.call('repoAllowsAutoMerge', {}, () => this.autoMergeAllowed);
  }

  prAutoMerge(input: { readonly repo: string; readonly url: string }): Promise<void> {
    return this.call('prAutoMerge', input, () => {
      this.autoMerged.push(input.url);
    });
  }

  /** A PR that exists already, as if opened by an earlier run or by hand. */
  openPr(branch: string, state: PrState = PrState.Open): string {
    return this.add(branch, state, '', null);
  }

  setState(url: string, state: PrState): void {
    const found = this.byRef.get(url);
    if (!found) throw new Error(`no PR ${url}`);
    found.pr.state = state;
  }

  /** The checks the PR's rollup shows from now on; a new PR has none. */
  setChecks(url: string, rollup: readonly CheckRollupEntry[]): void {
    const found = this.byRef.get(url);
    if (!found) throw new Error(`no PR ${url}`);
    found.rollup = rollup;
  }

  prCreates(): PrCreateCall[] {
    return [...new Set(this.byRef.values())].flatMap((e) => (e.create ? [e.create] : []));
  }

  body(url: string): string {
    return this.byRef.get(url)?.body ?? '';
  }

  private add(branch: string, state: PrState, body: string, create: PrCreateCall | null): string {
    const url = `https://github.com/${this.repo}/pull/${String(this.next++)}`;
    const entry = { pr: { url, state }, body, create, rollup: [] };
    this.byRef.set(branch, entry);
    this.byRef.set(url, entry);
    return url;
  }
}
