/**
 * BoardError is thrown when the Board gateway cannot complete a poll.
 *
 * The gateway distinguishes a small number of failure shapes so the
 * Conductor (and the developer reading logs) can react appropriately:
 *
 *   - "permission" : `gh` lacks the `project` scope. The fix is
 *     `gh auth refresh -s project`; the message includes that hint.
 *   - "gh-failed"  : the `gh` invocation exited non-zero for any other
 *     reason (network, missing project, auth, etc.).
 *   - "malformed"  : `gh` returned data the gateway could not interpret.
 *
 * In every case, no Run is started. The Conductor logs the error and
 * keeps polling.
 */
export type BoardErrorKind = "permission" | "gh-failed" | "malformed";

export class BoardError extends Error {
  public readonly kind: BoardErrorKind;
  public readonly detail?: string;

  constructor(kind: BoardErrorKind, message: string, detail?: string) {
    super(message);
    this.name = "BoardError";
    this.kind = kind;
    this.detail = detail;
  }
}
