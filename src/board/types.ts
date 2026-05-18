/**
 * Board domain types.
 *
 * A Task represents a single Queued GitHub Issue Board item that the
 * Conductor is ready to pick up. See PRD #1 user stories 3-6 and
 * Implementation Decisions.
 *
 * The Board gateway only emits Tasks for items that are:
 *   - GitHub Issues (not draft notes, not Pull Requests)
 *   - Currently in the Queued status on the configured status field
 *
 * Identifiers we keep are stable enough that later Phases can:
 *   - Update the Board item's status (`boardItemId`, `projectId`,
 *     `statusFieldId`).
 *   - Operate on the Issue via `gh issue` (`issueNumber`, repo identity).
 */

export interface RepositoryIdentity {
  owner: string;
  name: string;
}

export interface Task {
  /** Repository the Issue lives in. */
  repository: RepositoryIdentity;
  /** Issue number within `repository`. */
  issueNumber: number;
  /** Global GraphQL node id of the Issue. */
  issueId: string;
  /** Issue title (used for logs and prompt context). */
  title: string;
  /** Canonical HTML URL of the Issue. */
  url: string;
  /** Board item id (used for Board status updates). */
  boardItemId: string;
  /** GitHub Project node id (used for Board status updates). */
  projectId: string;
  /** Status field node id (used for Board status updates). */
  statusFieldId: string;
  /** Issue creation time as an ISO-8601 string. Used for oldest-first ordering. */
  createdAt: string;
}
