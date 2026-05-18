import type { GhResult, GhRunner } from "../board/index.ts";

export interface BoardTransitionConfig {
  owner: string;
  projectNumber: number;
  statusField: string;
}

export interface BoardTransitionServiceOptions {
  gh: GhRunner;
}

export interface BoardTransitionInput {
  projectItemId: string;
  toStatus: string;
}

interface FieldCache {
  projectId: string;
  fieldId: string;
  optionsByName: Map<string, string>;
}

const FIELD_OPTIONS_QUERY = `
query($owner: String!, $projectNumber: Int!, $statusField: String!) {
  organization(login: $owner) {
    projectV2(number: $projectNumber) {
      id
      field(name: $statusField) {
        ... on ProjectV2SingleSelectField {
          id
          options { id name }
        }
      }
    }
  }
  user(login: $owner) {
    projectV2(number: $projectNumber) {
      id
      field(name: $statusField) {
        ... on ProjectV2SingleSelectField {
          id
          options { id name }
        }
      }
    }
  }
}`;

const UPDATE_STATUS_MUTATION = `
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId,
    itemId: $itemId,
    fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId }
  }) {
    projectV2Item { id }
  }
}`;

/**
 * Write-side of the Board for the multi-queue scheduler. Knows how to
 * move a Board item to a given Status by human label, resolving the
 * underlying single-select option id on first use and caching it for
 * subsequent transitions.
 */
export class BoardTransitionService {
  private cache: FieldCache | undefined;

  constructor(
    private readonly board: BoardTransitionConfig,
    private readonly opts: BoardTransitionServiceOptions,
  ) {}

  public async applyTransition(input: BoardTransitionInput): Promise<void> {
    const cache = await this.ensureCache();
    const optionId = cache.optionsByName.get(input.toStatus);
    if (optionId === undefined) {
      const available = Array.from(cache.optionsByName.keys());
      throw new Error(
        `Unknown Board status '${input.toStatus}'. ` +
          `Available statuses: ${available.join(", ")}`,
      );
    }

    await this.runMutation({
      projectId: cache.projectId,
      fieldId: cache.fieldId,
      itemId: input.projectItemId,
      optionId,
    });
  }

  private async ensureCache(): Promise<FieldCache> {
    if (this.cache) return this.cache;
    const result = await this.opts.gh([
      "api",
      "graphql",
      "-F",
      `owner=${this.board.owner}`,
      "-F",
      `projectNumber=${this.board.projectNumber}`,
      "-F",
      `statusField=${this.board.statusField}`,
      "-f",
      `query=${FIELD_OPTIONS_QUERY}`,
    ]);
    this.failIfNonZero(result, "load Board status options");
    const parsed = JSON.parse(result.stdout) as unknown;
    const cache = extractCache(parsed);
    if (!cache) {
      throw new Error(
        "GitHub Project status field response did not include options",
      );
    }
    this.cache = cache;
    return cache;
  }

  private async runMutation(args: {
    projectId: string;
    fieldId: string;
    itemId: string;
    optionId: string;
  }): Promise<void> {
    const result = await this.opts.gh([
      "api",
      "graphql",
      "-F",
      `projectId=${args.projectId}`,
      "-F",
      `itemId=${args.itemId}`,
      "-F",
      `fieldId=${args.fieldId}`,
      "-F",
      `optionId=${args.optionId}`,
      "-f",
      `query=${UPDATE_STATUS_MUTATION}`,
    ]);
    this.failIfNonZero(result, "update Board status");
  }

  private failIfNonZero(result: GhResult, action: string): void {
    if (result.exitCode === 0) return;
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(
      `gh failed to ${action} (exit ${result.exitCode})${detail ? `: ${detail}` : ""}`,
    );
  }
}

function extractCache(root: unknown): FieldCache | undefined {
  if (!isObject(root)) return undefined;
  const data = root["data"];
  if (!isObject(data)) return undefined;
  const ownerNode =
    (isObject(data["organization"]) && data["organization"]) ||
    (isObject(data["user"]) && data["user"]) ||
    undefined;
  if (!ownerNode) return undefined;
  const project = ownerNode["projectV2"];
  if (!isObject(project)) return undefined;
  const projectId = project["id"];
  if (typeof projectId !== "string") return undefined;
  const field = project["field"];
  if (!isObject(field)) return undefined;
  const fieldId = field["id"];
  if (typeof fieldId !== "string") return undefined;
  const rawOptions = field["options"];
  if (!Array.isArray(rawOptions)) return undefined;

  const optionsByName = new Map<string, string>();
  for (const raw of rawOptions) {
    if (!isObject(raw)) return undefined;
    const id = raw["id"];
    const name = raw["name"];
    if (typeof id !== "string" || typeof name !== "string") return undefined;
    optionsByName.set(name, id);
  }
  return { projectId, fieldId, optionsByName };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
