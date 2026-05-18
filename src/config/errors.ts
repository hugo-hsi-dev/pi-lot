/**
 * ConfigError is thrown when the config file is missing, unreadable,
 * unparseable, or fails validation. The Conductor never starts polling
 * if any of these errors occur.
 *
 * The `issues` array contains one human-readable line per problem; the
 * top-level `message` is a short summary suitable for a one-line log.
 */
export class ConfigError extends Error {
  public readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "ConfigError";
    this.issues = issues;
  }

  /** Multi-line message for printing to stderr. */
  public format(): string {
    if (this.issues.length === 0) return this.message;
    const bullets = this.issues.map((i) => `  - ${i}`).join("\n");
    return `${this.message}\n${bullets}`;
  }
}
