/**
 * Normalize a git remote URL into `host/owner/repo` form so that
 * SSH (`git@github.com:owner/repo.git`), HTTPS
 * (`https://github.com/owner/repo.git`), and trailing-slash-free
 * variants of the same repository compare equal.
 *
 * Used by the remote-validation hook so a user-configured local clone
 * with one URL form still matches an Issue whose API surface returns
 * a different form. The Conductor never compares raw URLs directly.
 */
export function normalizeRemoteUrl(url: string): string {
  let s = url.trim();
  if (s.endsWith(".git")) s = s.slice(0, -".git".length);

  // git@host:owner/repo  ->  host/owner/repo
  const sshMatch = s.match(/^[a-zA-Z0-9._-]+@([^:]+):(.+)$/);
  if (sshMatch) {
    return `${sshMatch[1]!.toLowerCase()}/${sshMatch[2]!.toLowerCase()}`;
  }

  // ssh://user@host/owner/repo or https://host/owner/repo
  const urlMatch = s.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
  if (urlMatch) {
    const host = urlMatch[1]!.toLowerCase();
    const path = urlMatch[2]!.replace(/\/+$/, "").toLowerCase();
    return `${host}/${path}`;
  }

  return s.toLowerCase();
}
