// The git host behind a remote or a link: GitHub and GitLab call the same things differently, and GitLab allows
// nested groups. Everything that reads or writes a PR reads its host here first.

export const GITHUB = "github", GITLAB = "gitlab";

// The remote's host name, lowercased: "git@github.com:o/r.git", "ssh://git@g.example/o/r", "https://g.example/o/r.git".
export function remoteHost(remote) {
  const u = String(remote ?? "").trim();
  if (!u) return null;
  const scp = /^[\w.-]+@([\w.-]+):/.exec(u); // git@host:path
  if (scp) return scp[1].toLowerCase();
  try { return new URL(u).hostname.toLowerCase() || null; } catch { return null; }
}

// Which host a remote belongs to: its name says so, or the config names it. Unknown hosts stay unknown.
export function hostOf(remote, cfg = {}) {
  const named = String(cfg.host ?? "").toLowerCase();
  if (named === GITHUB || named === GITLAB) return named;
  const h = remoteHost(remote);
  if (!h) return null;
  if (h === "github.com") return GITHUB;
  if (h === "gitlab.com" || /(^|\.)gitlab[.-]/.test(h) || h.startsWith("gitlab.")) return GITLAB;
  return null;
}

// A remote's host name and repository path, keeping GitLab's nested groups: "git@gitlab.com:g/sub/p.git" →
// {host: "gitlab", hostname: "gitlab.com", repo: "g/sub/p"}. Null when there is no path.
export function parseRemote(remote, cfg = {}) {
  const u = String(remote ?? "").trim(), hostname = remoteHost(u);
  if (!hostname) return null;
  let path = "";
  const scp = /^[\w.-]+@[\w.-]+:(.+)$/.exec(u);
  if (scp) path = scp[1];
  else { try { path = new URL(u).pathname; } catch { return null; } }
  const repo = path.replace(/^\/+/, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (!repo || !repo.includes("/")) return null;
  return { host: hostOf(u, cfg), hostname, repo };
}

// A PR or MR link: GitHub's /pull/12 and GitLab's /-/merge_requests/12, with any page after it.
export function parseLink(url) {
  const u = String(url ?? "").trim(), hostname = remoteHost(u);
  if (!hostname) return null;
  const gh = /^\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#]|$)/.exec(new URL(u).pathname ?? "");
  if (hostname === "github.com" && gh) return { host: GITHUB, hostname, repo: gh[1], number: Number(gh[2]) };
  const gl = /^\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#]|$)/.exec(new URL(u).pathname ?? "");
  if (gl) return { host: GITLAB, hostname, repo: gl[1], number: Number(gl[2]) };
  return null;
}

// The web address of a PR or MR on its host.
export function webUrl(link) {
  if (!link?.hostname || !link?.repo || !link?.number) return null;
  return link.host === GITLAB
    ? `https://${link.hostname}/${link.repo}/-/merge_requests/${link.number}`
    : `https://${link.hostname}/${link.repo}/pull/${link.number}`;
}
