import type { BoardConfig } from "../config/index.ts";
import { BoardError } from "./errors.ts";
import type { GhResult, GhRunner } from "./gh.ts";
import type { Task } from "./types.ts";

export interface BoardGatewayOptions {
  /** Injected `gh` runner. Tests pass a mock; production passes the real one. */
  gh: GhRunner;
  /**
   * Sink for skipped non-Issue items. Optional; when omitted the
   * gateway falls back to `console.warn`. Tests can capture the lines.
   */
  warn?: (message: string) => void;
}

/**
 * Read-side of the Board. Encapsulates every `gh`-shaped detail of
 * turning the configured GitHub Project into Pi Lot Tasks. The Conductor
 * only knows about `pollQueuedTasks` and `Task`.
 */
export class BoardGateway {
  constructor(
    private readonly board: BoardConfig,
    private readonly opts: BoardGatewayOptions,
  ) {}

  /**
   * Return every Queued GitHub Issue item on the Board, oldest first.
   *
   * - Non-Issue Board items (draft notes, Pull Requests) are skipped
   *   with a local warning and never returned.
   * - Permission failures are surfaced as a `BoardError("permission",
   *   ...)` with the `gh auth refresh -s project` remediation hint.
   * - Malformed or incomplete `gh` output is surfaced as
   *   `BoardError("malformed", ...)` so no Run is started.
   */
  public async pollQueuedTasks(): Promise<Task[]> {
    const result = await this.runProjectQuery();
    return this.parseTasks(result);
  }

  private async runProjectQuery(): Promise<GhResult> {
    const args = [
      "api",
      "graphql",
      "-F",
      `owner=${this.board.owner}`,
      "-F",
      `projectNumber=${this.board.projectNumber}`,
      "-F",
      `statusField=${this.board.statusField}`,
      "-f",
      `query=${PROJECT_QUERY}`,
    ];
    return this.opts.gh(args);
  }

  private parseTasks(result: GhResult): Task[] {
    if (result.exitCode !== 0) {
      throw this.errorFromExit(result);
    }

    const root = this.parseJson(result.stdout);
    const project = this.extractProject(root);

    const queuedLabel = this.board.statusValues.queued;
    const tasks: Task[] = [];
    for (const node of project.items) {
      this.collectTask(node, project, queuedLabel, tasks);
    }
    return tasks;
  }

  private collectTask(
    node: unknown,
    project: ParsedProject,
    queuedLabel: string,
    tasks: Task[],
  ): void {
    if (!isObject(node)) {
      throw new BoardError(
        "malformed",
        "Board item is not an object",
      );
    }
    const itemId = node["id"];
    const type = node["type"];
    if (typeof itemId !== "string" || typeof type !== "string") {
      throw new BoardError(
        "malformed",
        "Board item is missing id or type",
      );
    }

    const status = this.extractStatus(node);
    if (status !== queuedLabel) return;

    if (type !== "ISSUE") {
      this.warn(
        `Pi Lot: skipping non-Issue Queued Board item ${itemId} (type=${type}); ` +
          `non-Issue items are not turned into Tasks.`,
      );
      return;
    }

    const content = node["content"];
    if (!isObject(content)) {
      throw new BoardError(
        "malformed",
        `Board item ${itemId} has no content payload`,
      );
    }
    const issueNumber = content["number"];
    const issueId = content["id"];
    const title = content["title"];
    const url = content["url"];
    const createdAt = content["createdAt"];
    const repository = content["repository"];
    if (
      typeof issueNumber !== "number" ||
      typeof issueId !== "string" ||
      typeof title !== "string" ||
      typeof url !== "string" ||
      typeof createdAt !== "string" ||
      !isObject(repository)
    ) {
      throw new BoardError(
        "malformed",
        `Board item ${itemId} Issue content is missing required fields`,
      );
    }
    const repoName = repository["name"];
    const owner = isObject(repository["owner"])
      ? repository["owner"]["login"]
      : undefined;
    if (typeof repoName !== "string" || typeof owner !== "string") {
      throw new BoardError(
        "malformed",
        `Board item ${itemId} Issue repository identity is missing`,
      );
    }

    tasks.push({
      repository: { owner, name: repoName },
      issueNumber,
      issueId,
      title,
      url,
      boardItemId: itemId,
      projectId: project.id,
      statusFieldId: project.statusFieldId,
      createdAt,
    });
  }

  private extractStatus(node: Record<string, unknown>): string | undefined {
    const fieldValues = node["fieldValues"];
    if (!isObject(fieldValues)) return undefined;
    const nodes = fieldValues["nodes"];
    if (!Array.isArray(nodes)) return undefined;
    for (const fv of nodes) {
      if (!isObject(fv)) continue;
      const field = fv["field"];
      if (!isObject(field)) continue;
      if (field["name"] !== this.board.statusField) continue;
      const name = fv["name"];
      if (typeof name === "string") return name;
    }
    return undefined;
  }

  private parseJson(stdout: string): unknown {
    try {
      return JSON.parse(stdout);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new BoardError(
        "malformed",
        "Board query returned non-JSON output",
        detail,
      );
    }
  }

  private extractProject(root: unknown): ParsedProject {
    if (!isObject(root)) {
      throw new BoardError("malformed", "Board response is not a JSON object");
    }
    const data = root["data"];
    if (!isObject(data)) {
      throw new BoardError("malformed", "Board response missing data");
    }
    // Either organization or user; we don't care which.
    const ownerNode = (isObject(data["organization"]) && data["organization"]) ||
      (isObject(data["user"]) && data["user"]) ||
      undefined;
    if (!ownerNode) {
      throw new BoardError(
        "malformed",
        "Board response does not contain a project owner",
      );
    }
    const project = ownerNode["projectV2"];
    if (!isObject(project)) {
      throw new BoardError("malformed", "Board response is missing projectV2");
    }
    const id = project["id"];
    if (typeof id !== "string") {
      throw new BoardError("malformed", "Board response is missing project id");
    }
    const field = project["field"];
    if (!isObject(field)) {
      throw new BoardError(
        "malformed",
        `Board response is missing the '${this.board.statusField}' field`,
      );
    }
    const statusFieldId = field["id"];
    if (typeof statusFieldId !== "string") {
      throw new BoardError(
        "malformed",
        `Board response is missing the '${this.board.statusField}' field id`,
      );
    }
    const items = project["items"];
    if (!isObject(items) || !Array.isArray(items["nodes"])) {
      throw new BoardError("malformed", "Board response items are missing");
    }
    return { id, statusFieldId, items: items["nodes"] };
  }

  private errorFromExit(result: GhResult): BoardError {
    const blob = `${result.stdout}\n${result.stderr}`.toLowerCase();
    const looksPermission =
      blob.includes("project") &&
      (blob.includes("scope") ||
        blob.includes("insufficient") ||
        blob.includes("forbidden") ||
        blob.includes("permission") ||
        blob.includes("not authorized"));
    if (looksPermission) {
      return new BoardError(
        "permission",
        "GitHub Project permissions missing for `gh`. " +
          "Run `gh auth refresh -s project` and retry.",
        result.stderr.trim() || result.stdout.trim() || undefined,
      );
    }
    return new BoardError(
      "gh-failed",
      `gh exited with code ${result.exitCode} while polling the Board`,
      result.stderr.trim() || result.stdout.trim() || undefined,
    );
  }

  private warn(line: string): void {
    if (this.opts.warn) {
      this.opts.warn(line);
      return;
    }
    console.warn(line);
  }
}

interface ParsedProject {
  id: string;
  statusFieldId: string;
  items: unknown[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * GraphQL query used by the Board gateway. We bind:
 *   $owner          : Project owner login (user or organization).
 *   $projectNumber  : Numeric project number from config.
 *   $statusField    : Name of the single-select status field.
 *
 * The query asks for both `organization` and `user` so the same query
 * works regardless of owner type. The unused branch resolves to null,
 * which the parser tolerates.
 */
const PROJECT_QUERY = `
query($owner: String!, $projectNumber: Int!, $statusField: String!) {
  organization(login: $owner) {
    projectV2(number: $projectNumber) {
      id
      field(name: $statusField) { ... on ProjectV2SingleSelectField { id name } }
      items(first: 100) {
        nodes {
          id
          type
          fieldValues(first: 20) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
            }
          }
          content {
            __typename
            ... on Issue {
              number id title url createdAt
              repository { owner { login } name }
            }
            ... on PullRequest { number url }
            ... on DraftIssue { title }
          }
        }
      }
    }
  }
  user(login: $owner) {
    projectV2(number: $projectNumber) {
      id
      field(name: $statusField) { ... on ProjectV2SingleSelectField { id name } }
      items(first: 100) {
        nodes {
          id
          type
          fieldValues(first: 20) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
            }
          }
          content {
            __typename
            ... on Issue {
              number id title url createdAt
              repository { owner { login } name }
            }
            ... on PullRequest { number url }
            ... on DraftIssue { title }
          }
        }
      }
    }
  }
}
`;
