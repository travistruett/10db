import type { ProjectId, SessionId, TaskId, WorkstreamId } from '@10db/contracts';
import type { FileAccessContext, ProcessMember } from '../sandbox';

/** What a lane session lends its browser; the runner builds it from the session's sandbox. */
export interface LaneBrowserSession {
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly workstreamId: WorkstreamId;
  /** Real paths: the session's checkout and its own temp dir. */
  readonly copy: string;
  readonly tempDir: string;
  readonly fileAccess: FileAccessContext;
  /** Every project's checkout, real paths: a compose dir inside one owns nothing. */
  readonly registeredCheckouts: readonly string[];
  readonly loopback: boolean;
  readonly docker: boolean;
  /** The session's process ledger as it reads now. */
  members(): readonly ProcessMember[];
}
