import { BoardError } from "./errors.ts";
import type { GhResult, GhRunner } from "./gh.ts";

export interface MultiQueueBoardConfig {
  owner: string;
  projectNumber: number;
  statusField: string;
}

export interface MultiQueueBoardGatewayOptions {
  gh: GhRunner;
  warn?: (message: string) => void;
}

export interface Candidate {
  repository: { owner: string; name: string };
  issueNumber: number;
  title: string;
  url: string;
  /** Source human Board status string (= configured queue name). */
  status: string;
  /** GitHub Issue createdAt (ISO-8601). */
  createdAt: string;
  /**
   * GitHub Project item id (PVTI_...). The Orchestrator passes this
   * through to {@link BoardTransitionService.applyTransition} when
   * moving the Board to the Task Definition's `next` status.
   */
  projectItemId: string;
}

/**
 * Read-side of a multi-queue Board. The Conductor configures one or more
 * human-facing Board statuses that each map to a Task Definition; this
 * gateway polls every Board item once and returns the subset whose Status
 * is in the supplied queue list.
 */
export class MultiQueueBoardGateway {
  constructor(
    private readonly board: MultiQueueBoardConfig,
    private readonly opts: MultiQueueBoardGatewayOptions,
  ) {}

  public async pollEligibleCandidates(
    queueNames: readonly string[],
  ): Promise<Candidate[]> {
    const result = await this.runProjectQuery();
    return this.parseCandidates(result, queueNames);
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

  private parseCandidates(
    result: GhResult,
    queueNames: readonly string[],
  ): Candidate[] {
    if (result.exitCode !== 0) {
      throw this.errorFromExit(result);
    }
    const queues = new Set(queueNames);
    const root = this.parseJson(result.stdout);
    const items = this.extractItems(root);

    const out: Candidate[] = [];
    for (const node of items) {
      const candidate = this.maybeCandidate(node, queues);
      if (candidate) out.push(candidate);
    }
    return out;
  }

  private maybeCandidate(
    node: unknown,
    queues: Set<string>,
  ): Candidate | undefined {
    if (!isObject(node)) return undefined;
    const itemId = node["id"];
    const type = node["type"];
    if (typeof itemId !== "string" || typeof type !== "string") return undefined;

    const status = this.extractStatus(node);
    if (!status || !queues.has(status)) return undefined;

    if (type !== "ISSUE") {
      this.warn(
        `Pi Lot: skipping non-Issue Board item ${itemId} (type=${type}) ` +
          `in queue '${status}'.`,
      );
      return undefined;
    }

    const content = node["content"];
    if (!isObject(content)) return undefined;
    const issueNumber = content["number"];
    const title = content["title"];
    const url = content["url"];
    const createdAt = content["createdAt"];
    const repository = content["repository"];
    if (
      typeof issueNumber !== "number" ||
      typeof title !== "string" ||
      typeof url !== "string" ||
      typeof createdAt !== "string" ||
      !isObject(repository)
    ) {
      return undefined;
    }
    const repoName = repository["name"];
    const owner = isObject(repository["owner"])
      ? repository["owner"]["login"]
      : undefined;
    if (typeof repoName !== "string" || typeof owner !== "string") {
      return undefined;
    }

    return {
      repository: { owner, name: repoName },
      issueNumber,
      title,
      url,
      status,
      createdAt,
      projectItemId: itemId,
    };
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

  private extractItems(root: unknown): unknown[] {
    if (!isObject(root)) {
      throw new BoardError("malformed", "Board response is not a JSON object");
    }
    const data = root["data"];
    if (!isObject(data)) {
      throw new BoardError("malformed", "Board response missing data");
    }
    const ownerNode =
      (isObject(data["organization"]) && data["organization"]) ||
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
    const items = project["items"];
    if (!isObject(items) || !Array.isArray(items["nodes"])) {
      throw new BoardError("malformed", "Board response items are missing");
    }
    return items["nodes"];
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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const PROJECT_QUERY = `
query($owner: String!, $projectNumber: Int!, $statusField: String!) {
  organization(login: $owner) {
    projectV2(number: $projectNumber) {
      id
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
