import { LinearEventKind, type LinearPostDto } from '@10db/contracts';

// Pure: what an owed update's post needs from its detail. A row that lacks it has nothing to say on the issue,
// so the reporter withholds it without a session rather than hand an agent an update it can't post.

const present = (value: unknown): boolean => typeof value === 'string' && value !== '';

/** True when the row's detail lacks what its post needs: a PR url for a PR update, a base and commit for a landing. */
export function nothingToReport(post: Pick<LinearPostDto, 'event' | 'detail'>): boolean {
  switch (post.event) {
    case LinearEventKind.PrOpened:
    case LinearEventKind.PrMerged:
      return !present(post.detail['prUrl']);
    case LinearEventKind.Landed:
      return !present(post.detail['baseBranch']) || !present(post.detail['commit']);
    case LinearEventKind.RunStarted:
    case LinearEventKind.Waiting:
    case LinearEventKind.Verdict:
    case LinearEventKind.Ended:
      return false;
  }
}
