/**
 * Sandcastle-style prompt renderer (issue #24, PRD #1 user stories 13-16, 50).
 *
 * Substitutes `{{UPPER_SNAKE_CASE}}` placeholders in a template string
 * from a context map. Anything inside `{{ ... }}` that is NOT a valid
 * UPPER_SNAKE_CASE name is treated as literal text and left unchanged
 * (prompt templates sometimes show code examples that contain double
 * braces).
 *
 * Throws `UnknownPlaceholderError` when a valid placeholder name is
 * encountered but is missing from the context — surfacing template /
 * context drift loudly rather than silently producing wrong prompts.
 */

export class UnknownPlaceholderError extends Error {
  readonly placeholder: string;
  constructor(name: string) {
    super(`Unknown placeholder: ${name}`);
    this.placeholder = name;
    this.name = "UnknownPlaceholderError";
  }
}

export function renderPrompt(
  template: string,
  context: Readonly<Record<string, string>>,
): string {
  return template.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (_match, name) => {
    const key = name as string;
    if (!Object.prototype.hasOwnProperty.call(context, key)) {
      throw new UnknownPlaceholderError(key);
    }
    return context[key] as string;
  });
}
