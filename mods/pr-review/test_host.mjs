// Run: node --test test_host.mjs  (the git host behind a remote or a link)
import assert from "node:assert/strict";
import { hostOf, parseRemote, parseLink, webUrl, remoteHost, GITHUB, GITLAB } from "./host.js";

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
console.log("ok");
