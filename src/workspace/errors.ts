/**
 * Errors thrown by the workspace provisioner.
 *
 * RepositoryNotFoundError signals that the flat projects-directory entry
 * for an Issue's repository is missing. Issue #6 treats this as fatal;
 * cloning the missing repository is handled by issue #7.
 *
 * RemoteMismatchError signals that the local repository at the expected
 * flat path points at a different `origin` than the Issue's repository.
 * The Conductor maps this to the "skip Task" policy in issue #7.
 */

export class RepositoryNotFoundError extends Error {
  public readonly owner: string;
  public readonly repo: string;
  public readonly expectedPath: string;

  constructor(opts: { owner: string; repo: string; expectedPath: string }) {
    super(
      `No local clone of ${opts.owner}/${opts.repo} at ${opts.expectedPath}. ` +
        `Cloning missing repositories is tracked in #7.`,
    );
    this.name = "RepositoryNotFoundError";
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.expectedPath = opts.expectedPath;
  }
}

export class RemoteMismatchError extends Error {
  public readonly owner: string;
  public readonly repo: string;
  public readonly repoPath: string;
  public readonly expectedRemote: string;
  public readonly actualRemote: string;

  constructor(opts: {
    owner: string;
    repo: string;
    repoPath: string;
    expectedRemote: string;
    actualRemote: string;
  }) {
    super(
      `Local repository at ${opts.repoPath} has origin ${opts.actualRemote}, ` +
        `but Issue points at ${opts.expectedRemote}.`,
    );
    this.name = "RemoteMismatchError";
    this.owner = opts.owner;
    this.repo = opts.repo;
    this.repoPath = opts.repoPath;
    this.expectedRemote = opts.expectedRemote;
    this.actualRemote = opts.actualRemote;
  }
}
