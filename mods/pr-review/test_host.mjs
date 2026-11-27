// Run: node --test test_host.mjs  (the git host behind a remote or a link)
import assert from "node:assert/strict";
import { hostOf, hostOfLink, parseRemote, parseLink, webUrl, remoteHost, GITHUB, GITLAB, HOST_WORD, HOST_LONG, hostWord, hostLong } from "./host.js";

assert.equal(remoteHost("git@gitlab.com:g/p.git"), "gitlab.com");
assert.equal(remoteHost("ssh://git.example.com/g/p.git"), "git.example.com");
assert.equal(remoteHost("https://github.com/o/r.git"), "github.com");
assert.equal(remoteHost(""), null);
assert.equal(remoteHost("not a url"), null);

assert.equal(hostOf("git@github.com:o/r.git"), GITHUB);
assert.equal(hostOf("https://gitlab.com/g/p.git"), GITLAB);
assert.equal(hostOf("https://gitlab.example.com/g/p.git"), GITLAB);
assert.equal(hostOf("git@git.example.com:g/p.git"), null);
assert.equal(hostOf("git@git.example.com:g/p.git", { host: "gitlab" }), GITLAB); // the config names an unknown host

assert.deepEqual(parseRemote("git@gitlab.com:group/sub/project.git"), { host: GITLAB, hostname: "gitlab.com", repo: "group/sub/project" });
assert.deepEqual(parseRemote("https://github.com/o/r.git"), { host: GITHUB, hostname: "github.com", repo: "o/r" });
assert.deepEqual(parseRemote("https://gitlab.example.com/g/p"), { host: GITLAB, hostname: "gitlab.example.com", repo: "g/p" });
assert.equal(parseRemote("https://github.com/o"), null);

assert.deepEqual(parseLink("https://github.com/o/r/pull/12"), { host: GITHUB, hostname: "github.com", repo: "o/r", number: 12 });
assert.deepEqual(parseLink("https://github.com/o/r/pull/12/files"), { host: GITHUB, hostname: "github.com", repo: "o/r", number: 12 });
assert.deepEqual(parseLink("https://gitlab.com/g/sub/p/-/merge_requests/7"), { host: GITLAB, hostname: "gitlab.com", repo: "g/sub/p", number: 7 });
assert.deepEqual(parseLink("https://gitlab.com/g/sub/p/-/merge_requests/7/diffs"), { host: GITLAB, hostname: "gitlab.com", repo: "g/sub/p", number: 7 });
assert.equal(parseLink("https://gitlab.com/g/p/merge_requests/7"), null); // no /-/: not a GitLab web link
assert.equal(parseLink("https://example.com/x"), null);

assert.equal(webUrl({ host: GITHUB, hostname: "github.com", repo: "o/r", number: 12 }), "https://github.com/o/r/pull/12");
assert.equal(webUrl({ host: GITLAB, hostname: "gitlab.com", repo: "g/sub/p", number: 7 }), "https://gitlab.com/g/sub/p/-/merge_requests/7");
assert.equal(webUrl(null), null);
assert.equal(hostOfLink("https://gitlab.com/g/sub/p/-/merge_requests/7"), GITLAB);
assert.equal(hostOfLink("https://git.company.example/g/p/-/merge_requests/7"), GITLAB); // a self-hosted name needs no setting
assert.equal(hostOfLink("https://github.com/o/r/pull/12"), GITHUB);
assert.equal(hostOfLink("https://example.com/x"), null);

// The noun a host gives its change request: PR on GitHub, MR on a GitLab merge request, PR when nothing names it.
assert.deepEqual(HOST_WORD, { github: "PR", gitlab: "MR" });
assert.deepEqual(HOST_LONG, { github: "pull request", gitlab: "merge request" });
assert.equal(hostWord("https://github.com/o/r/pull/12"), "PR");
assert.equal(hostWord("https://gitlab.com/group/sub/p/-/merge_requests/7"), "MR"); // a nested group
assert.equal(hostWord("https://gitlab.example.com/g/p/-/merge_requests/3"), "MR"); // a self-hosted name
assert.equal(hostWord({ host: "gitlab" }), "MR");
assert.equal(hostWord({ host: "github" }), "PR");
assert.equal(hostWord("gitlab"), "MR");
assert.equal(hostWord("github"), "PR");
assert.equal(hostWord(parseLink("https://gitlab.com/g/sub/p/-/merge_requests/7")), "MR"); // a parsed link
assert.equal(hostWord({ host: null }), "PR");
assert.equal(hostWord("https://example.com/x"), "PR"); // a host nothing names
assert.equal(hostWord(null), "PR");
assert.equal(hostWord(undefined), "PR");
assert.equal(hostLong("https://github.com/o/r/pull/12"), "pull request");
assert.equal(hostLong("https://gitlab.com/g/sub/p/-/merge_requests/7"), "merge request");
assert.equal(hostLong({ host: "gitlab" }), "merge request");
assert.equal(hostLong("gitlab"), "merge request");
assert.equal(hostLong("https://example.com/x"), "pull request");
assert.equal(hostLong(null), "pull request");
console.log("ok");
