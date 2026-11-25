// Run: node test_setup.mjs  (Setup's detection → report mapping, with stubbed PATH lookups; Codex detection)
import assert from "node:assert/strict";
import { parseCheck, report, blockers, found, programs, checkScript, pretypeArgv, installHint, harnessTool, harnessCommand } from "./setup.js";

const out = (have, auth = "") => programs().map((p) => `${p}=${have.includes(p) ? `/bin/${p}` : ""}`).join("\n") + "\n" + auth;
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

// Everything there and logged in: all ok, no blockers, no install commands.
const all = parseCheck(out(programs(), "auth:gh=1\nauth:glab=1\nauth:claude=1"));
assert.ok(report(all).every((r) => r.status === "ok" && r.install === null));
assert.deepEqual(blockers(report(all)), []);
assert.equal(found(all, "codex"), true);

// Only the required ones: optional and language servers are "optional-missing" with what they enable.
const min = parseCheck(out(["git", "gh", "claude", "python3"], "auth:gh=1\nauth:claude=1"));
const r = byId(report(min, "darwin"));
assert.equal(r.codex.status, "optional-missing");
assert.equal(found(min, "codex"), false); // Codex detection: no codex on PATH, no Codex reviewer
assert.equal(r.jdtls.status, "optional-missing");
assert.equal(r.jdtls.what, "Go to definition and Impact in Java need jdtls");
assert.equal(r.jdtls.install, "brew install jdtls");
assert.equal(report(min, "linux").find((x) => x.id === "jdtls").install, null); // no simple Linux command
assert.equal(r["typescript-language-server"].what, "Go to definition and Impact in TypeScript and JavaScript need typescript-language-server + tsc");
assert.equal(r["terraform-ls"].what, "Go to definition in Terraform needs terraform-ls"); // Impact leaves Terraform to Infrastructure changes
// A language server the bridge could not start: the message names the language, this system's command and Setup.
assert.equal(installHint("pyright-langserver is not installed"), "pyright-langserver is not installed (the language server for Python). Install it with `npm install -g pyright`; the panel's Setup (PRs ▾ → Setup) offers the same command.");
assert.equal(installHint("tsc is not installed", "linux"), "tsc is not installed (the language server for TypeScript and JavaScript). Install it with `npm install -g typescript-language-server typescript`; the panel's Setup (PRs ▾ → Setup) offers the same command.");
assert.equal(installHint("jdtls is not installed", "linux"), "jdtls is not installed (the language server for Java). The panel's Setup (PRs ▾ → Setup) lists it; there is no one-line install for this system.");
assert.equal(installHint("Python server did not answer within 20 s"), "Python server did not answer within 20 s");
assert.deepEqual(blockers(report(min)), []);

// A program for one system only shows there: bwrap is the probes' sandbox on Linux (macOS has sandbox-exec built in).
assert.equal(byId(report(min, "darwin")).bwrap, undefined);
assert.deepEqual([byId(report(min, "linux")).bwrap.status, byId(report(min, "linux")).bwrap.install], ["optional-missing", "sudo apt install bubblewrap"]);
assert.match(byId(report(min, "linux")).bwrap.what, /Without it every probe asks first and its script runs with no sandbox/);
// What a feature needs beyond the program being there, and what happens without it, stands in the row.
assert.match(r.git.what, /From 2\.46 on.*with an older git they do not start in such a clone/);
assert.match(r.codex.what, /permission profile that reads only the PR checkout.*fails the run instead of reading more/);

// A server without its companion (tsc) counts as missing.
const half = parseCheck(out(["git", "gh", "claude", "python3", "typescript-language-server"], "auth:gh=1\nauth:claude=1"));
assert.equal(byId(report(half))["typescript-language-server"].status, "optional-missing");

// A one-of group needs one member: git/gh alone satisfies "git", and claude alone satisfies "llm".
assert.equal(r.glab.status, "missing"); // the other git CLI is absent, and that is not a blocker
assert.equal(blockers(report(min)).length, 0);
assert.match(r.claude.what, /Claude Code CLI/);

// No git CLI and no harness or claude: each group blocks once, named with its members.
const bad = parseCheck(out(["git", "python3"]));
const b = byId(report(bad, "darwin"));
assert.equal(b.gh.status, "missing");
assert.equal(b.gh.install, "brew install gh");
assert.equal(b.glab.status, "missing");
assert.equal(b.glab.install, "brew install glab");
assert.equal(b.claude.status, "missing");
assert.equal(b.claude.install, "npm install -g @anthropic-ai/claude-code");
assert.deepEqual(blockers(report(bad)).map((x) => x.id), ["gh or glab", "claude"]);

// gh installed but signed out, glab absent: the group blocks once, and the login command is the fix.
const out2 = byId(report(parseCheck(out(["git", "gh", "claude", "python3"], "auth:gh=0\nauth:claude=1")), "darwin"));
assert.equal(out2.gh.status, "logged-out");
assert.equal(out2.gh.install, "gh auth login");
assert.deepEqual(blockers(report(parseCheck(out(["git", "gh", "claude", "python3"], "auth:gh=0\nauth:claude=1")))).map((x) => x.id), ["gh or glab"]);

// A custom harness from pr-review.config.json stands in the llm group: the pane lists it and claude is optional.
const cfg = { harness: { command: ["opencode", "run"] } };
const hrow = harnessTool(cfg);
assert.equal(hrow.id, "harness");
assert.equal(hrow.group, "llm");
assert.deepEqual(hrow.command, ["opencode", "run"]);
assert.deepEqual(harnessCommand({ harness: { command: "opencode run" } }), ["opencode", "run"]);
assert.equal(harnessTool({}), null);
const hv = parseCheck(out(["git", "glab", "python3"], "auth:glab=1\n") + "opencode=/usr/local/bin/opencode\n");
const hr = byId(report(hv, "darwin", [hrow]));
assert.equal(hr.harness.status, "ok");
assert.equal(hr.harness.cmd, "opencode run");
assert.equal(hr.claude.status, "missing"); // still listed, no longer required: the harness is there
assert.deepEqual(blockers(report(hv, "darwin", [hrow])), []);
assert.ok(checkScript(["opencode"]).includes("opencode"));

// Nothing checked yet: Codex is not offered.
assert.equal(found(undefined, "codex"), false);
// The script asks for every program, and the pre-typed terminal never runs the command by itself.
assert.ok(programs().every((p) => checkScript().includes(p)));
const argv = pretypeArgv("brew install glab");
assert.equal(argv[0], "sh");
assert.equal(argv.at(-1), "brew install glab");
assert.ok(/vared/.test(argv[2]) && /read -e -i/.test(argv[2]));
// The editors of "Open in <Editor>": optional, and on macOS the app alone counts (the links open through the app).
{
  const script = checkScript();
  assert.ok(script.includes('"Visual Studio Code"') && script.includes('"IntelliJ IDEA Ultimate"') && script.includes("printf '%s=%s\\n' code"), "the check also looks for the apps");
  const got = parseCheck("git=/usr/bin/git\ncode=\nidea=\ncode=/Applications/Visual Studio Code.app\n"), rows = report(got, "darwin");
  assert.deepEqual([rows.find((r) => r.id === "code").status, rows.find((r) => r.id === "idea").status, rows.find((r) => r.id === "idea").need], ["ok", "optional-missing", "optional"]);
}
console.log("ok");
