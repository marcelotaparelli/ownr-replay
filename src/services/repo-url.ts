export type GithubRepo = { owner: string; name: string; url: string };

const MAX_URL_LENGTH = 200;
const REPO_PATH = /^\/(?<owner>[A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/(?<name>[A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

/**
 * Strict allow-list for ingestion (anti-SSRF): https://github.com/<owner>/<repo> only.
 * No credentials, ports, other hosts, IPs, query strings or extra path segments.
 */
export function parseGithubRepoUrl(input: string): GithubRepo | undefined {
  if (input.length > MAX_URL_LENGTH || !URL.canParse(input.trim())) return undefined;
  const url = new URL(input.trim());
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port !== "") return undefined;
  if (url.username || url.password || url.search || url.hash) return undefined;
  const { owner, name } = REPO_PATH.exec(url.pathname)?.groups ?? {};
  if (!owner || !name || name === "." || name === "..") return undefined;
  return { owner, name, url: `https://github.com/${owner}/${name}` };
}
