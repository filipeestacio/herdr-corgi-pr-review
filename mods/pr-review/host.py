"""The git host behind a remote or a link, for the scripts that call a host's CLI: GitHub and GitLab call the same
things differently, and GitLab allows nested groups. Mirrors host.js; keep the two in step.
"""
import re
from urllib.parse import urlsplit

GITHUB, GITLAB = "github", "gitlab"
SCP = re.compile(r"^[\w.-]+@([\w.-]+):(.+)$")
GH_LINK = re.compile(r"^/([\w.-]+/[\w.-]+)/pull/(\d+)(?:[/?#]|$)")
GL_LINK = re.compile(r"^/(.+?)/-/merge_requests/(\d+)(?:[/?#]|$)")


def remote_host(remote):
    """The remote's host name, lowercased; None when it has none."""
    u = str(remote or "").strip()
    if not u:
        return None
    m = SCP.match(u)
    if m:
        return m.group(1).lower()
    try:
        return (urlsplit(u).hostname or "").lower() or None
    except ValueError:
        return None


def host_of(remote, cfg=None):
    """github, gitlab, or None for a host whose name does not say, unless cfg["host"] names it."""
    named = str((cfg or {}).get("host") or "").lower()
    if named in (GITHUB, GITLAB):
        return named
    h = remote_host(remote)
    if not h:
        return None
    if h == "github.com":
        return GITHUB
    if h == "gitlab.com" or h.startswith("gitlab.") or re.search(r"(^|\.)gitlab[.-]", h):
        return GITLAB
    return None


def parse_remote(remote, cfg=None):
    """{host, hostname, repo} for a remote, keeping nested groups; None without a path."""
    u = str(remote or "").strip()
    hostname = remote_host(u)
    if not hostname:
        return None
    m = SCP.match(u)
    if m:
        path = m.group(2)
    else:
        try:
            path = urlsplit(u).path
        except ValueError:
            return None
    repo = re.sub(r"^/+", "", path)
    repo = re.sub(r"\.git$", "", repo)
    repo = re.sub(r"/+$", "", repo)
    if not repo or "/" not in repo:
        return None
    return {"host": host_of(u, cfg), "hostname": hostname, "repo": repo}


def parse_link(url):
    """{host, hostname, repo, number} for a PR or MR link (GitHub /pull/12, GitLab /-/merge_requests/12); None."""
    u = str(url or "").strip()
    hostname = remote_host(u)
    if not hostname:
        return None
    try:
        path = urlsplit(u).path
    except ValueError:
        return None
    if hostname == "github.com":
        m = GH_LINK.match(path)
        if m:
            return {"host": GITHUB, "hostname": hostname, "repo": m.group(1), "number": int(m.group(2))}
    m = GL_LINK.match(path)
    if m:
        return {"host": GITLAB, "hostname": hostname, "repo": m.group(1), "number": int(m.group(2))}
    return None


def web_url(link):
    """The web address of a PR or MR on its host; None when the link is incomplete."""
    link = link or {}
    if not (link.get("hostname") and link.get("repo") and link.get("number")):
        return None
    if link.get("host") == GITLAB:
        return f"https://{link['hostname']}/{link['repo']}/-/merge_requests/{link['number']}"
    return f"https://{link['hostname']}/{link['repo']}/pull/{link['number']}"
