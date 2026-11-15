// Run: node test_syntax.mjs
import assert from "node:assert/strict";
import { tokenize, langOf, firstLineOf, highlightRows, highlightLines, colors, contrast, runs, renderLine, refAt, highlightJob, highlightStep } from "./syntax.js";

// [text, kind] pairs of a line, for readable asserts.
const kinds = (line, lang, state = null) => tokenize(line, lang, state).spans.map((s) => [line.slice(s.start, s.end), s.kind]);
const has = (line, lang, pair, state) => assert.ok(kinds(line, lang, state).some(([t, k]) => t === pair[0] && k === pair[1]), `${lang}: ${JSON.stringify(pair)} in ${JSON.stringify(kinds(line, lang, state))}`);

assert.equal(langOf("src/a.tsx"), "js");
assert.equal(langOf("x/Dockerfile"), "dockerfile");
assert.equal(langOf("main.tf"), "hcl");
assert.equal(langOf("sketch.ino"), "cpp");
assert.equal(langOf("README.md"), "markdown");
assert.equal(langOf("build.gradle.kts"), "kotlin");
assert.equal(langOf("LICENSE"), null);
// Shell by its name: endings, dotfiles, templates of a script, Git hooks, make and just.
for (const p of ["a.sh", "a.bash", "a.zsh", "a.ksh", "a.fish", "test/load.bats", "Start.command", ".envrc", "home/.bashrc", ".zshrc", ".profile", ".env", ".env.local", "prod.env",
  "infra/user_data.sh.tpl", "boot.sh.tftpl", "Makefile", "rules.mk", "justfile", "hooks/pre-commit", ".husky/commit-msg", ".githooks/pre-push"]) assert.equal(langOf(p), "shell", p);
assert.equal(langOf("config.yaml.tpl"), "yaml");
assert.equal(langOf("docs/hooks/readme"), "shell"); // a guess by the folder, which the first line overrules:
assert.equal(langOf("hooks/pre-commit", "#!/usr/bin/env python3"), "python");
// A file without an ending, by its first line.
for (const [first, lang] of [["#!/bin/sh", "shell"], ["#!/bin/bash -eu", "shell"], ["#! /usr/bin/env bash", "shell"], ["#!/usr/bin/env zsh", "shell"], ["#!/usr/bin/env dash", "shell"], ["#!/bin/ksh", "shell"],
  ["#!/usr/bin/env -S bash -x", "shell"], ["#!/usr/bin/python3.12", "python"], ["#!/usr/bin/env python", "python"], ["#!/usr/bin/env node", "js"], ["#!/usr/bin/env -S deno run", "js"],
  ["#!/usr/bin/perl", null], ["# just a comment", null], ["", null]]) assert.equal(langOf("bin/release", first), lang, first);
assert.equal(langOf("tool.py", "#!/bin/sh"), "python"); // the ending wins
// firstLineOf: line 1 from a file's diff, or that the file is executable when the diff starts further down.
assert.equal(firstLineOf(["diff --git a/bin/x b/bin/x", "new file mode 100755", "index 0000000..1111111", "--- /dev/null", "+++ b/bin/x", "@@ -0,0 +1,2 @@", "+#!/usr/bin/env bash", "+echo hi"]), "#!/usr/bin/env bash");
assert.equal(firstLineOf(["diff --git a/bin/x b/bin/x", "deleted file mode 100755", "--- a/bin/x", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-#!/bin/sh", "-echo hi"]), "#!/bin/sh");
assert.equal(langOf("bin/x", firstLineOf(["diff --git a/bin/x b/bin/x", "index 2222222..3333333 100755", "--- a/bin/x", "+++ b/bin/x", "@@ -12,3 +12,3 @@", " a", "-b", "+c"])), "shell");
assert.equal(langOf("bin/x", firstLineOf(["diff --git a/bin/x b/bin/x", "index 2222222..3333333 100644", "--- a/bin/x", "+++ b/bin/x", "@@ -12,3 +12,3 @@", " a"])), null);
assert.equal(langOf("NOTES", firstLineOf(["new file mode 100755", "@@ -0,0 +1 @@", "+Just text."])), null); // line 1 is known and no "#!"
assert.equal(firstLineOf([]), "");

// JS/TS: keywords, definitions, calls, members, PascalCase types, strings, comments.
const ts = kinds('export class Foo extends Bar { run() { return this.x.go(1, "a") } } // done', "js");
for (const p of [["export", "keyword"], ["Foo", "type"], ["Bar", "type"], ["run", "function"], ["go", "function"], ["x", "variable"], ["1", "number"], ['"a"', "string"], ["// done", "comment"]])
  assert.ok(ts.some(([t, k]) => t === p[0] && k === p[1]), JSON.stringify(p));
assert.ok(tokenize("const s = new Map()", "js").spans.find((s) => s.kind === "type").ref);
// Block comment and template literal carried across lines.
let r = tokenize("const a = 1; /* start", "js");
assert.deepEqual(r.state, { c: 1, end: "*/" });
r = tokenize("still comment */ const b = `x", "js", r.state);
assert.deepEqual(r.spans[0], { start: 0, end: 16, kind: "comment" });
assert.deepEqual(r.state, { end: "`" });
assert.deepEqual(kinds("y` + z", "js", r.state)[0], ["y`", "string"]);

// Python: def/class, decorators, f-strings, triple quotes across lines.
has("def load(path: str) -> Config:", "python", ["load", "function"]);
has("def load(path: str) -> Config:", "python", ["Config", "type"]);
has("@dataclass", "python", ["@dataclass", "function"]);
has('x = f"{a}" if True else None', "python", ['f"{a}"', "string"]);
has("x = True", "python", ["True", "boolean"]);
r = tokenize('doc = """first', "python");
assert.deepEqual(r.state, { end: '"""' });
r = tokenize('end""" + str(x)', "python", r.state);
assert.equal(r.state, null);
assert.deepEqual(kinds('end""" + str(x)', "python", { end: '"""' })[0], ['end"""', "string"]);

// Java: annotations, text blocks, generics.
has("@Override public List<String> names() {", "java", ["@Override", "type"]);
has("@Override public List<String> names() {", "java", ["List", "type"]);
has("record Point(int x, int y) {}", "java", ["Point", "type"]);
assert.deepEqual(tokenize('String q = """', "java").state, { end: '"""' });

// Go, Rust, HCL, YAML, JSON, Shell, SQL, Dockerfile, C++.
has("func (s *Server) Handle(w http.ResponseWriter) error {", "go", ["Handle", "function"]);
has("func (s *Server) Handle(w http.ResponseWriter) error {", "go", ["error", "type"]);
assert.deepEqual(tokenize("var s = `raw", "go").state, { end: "`" });
has("fn parse<'a>(s: &'a str) -> Result<Self, Error> { println!(\"x\"); }", "rust", ["parse", "function"]);
has("fn parse<'a>(s: &'a str) -> Result<Self, Error> { println!(\"x\"); }", "rust", ["'a", "type"]);
has("fn parse<'a>(s: &'a str) -> Result<Self, Error> { println!(\"x\"); }", "rust", ["println", "function"]);
has('resource "aws_s3_bucket" "logs" {', "hcl", ["resource", "keyword"]);
has("  bucket = var.name # c", "hcl", ["bucket", "variable"]);
r = tokenize("  policy = <<EOF", "hcl");
assert.deepEqual(r.state, { h: "EOF" });
assert.equal(tokenize("EOF", "hcl", r.state).state, null);
has("on: [push] # trigger", "yaml", ["on", "function"]);
has("enabled: true", "yaml", ["true", "boolean"]);
has('{"name": "x", "n": 1, "ok": null}', "json", ['"name"', "function"]);
has('{"name": "x", "n": 1, "ok": null}', "json", ['"x"', "string"]);
has('git log --format="%h" $REV | head', "shell", ["git", "function"]);
has('git log --format="%h" $REV | head', "shell", ["$REV", "constant"]);
has('git log --format="%h" $REV | head', "shell", ["head", "function"]);
// Shell: a script as it is written (invented), line by line with the state carried on.
{
  const script = String.raw`#!/usr/bin/env bash
# Rotates the signing key of the reminder queue.
set -euo pipefail
readonly QUEUE="library-reminders"
KEEP=3
STATE_DIR="${"$"}{STATE_DIR:-$HOME/.cache/rotate-$QUEUE}"
declare -a KEYS=("primary" "standby")
url="https://example.test/keys#latest"   # the fragment is no comment
log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
function usage {
  cat <<-EOF
	usage: $0 status | rotate [--keep N]
	EOF
}
newest() {
  local count=${"$"}{#KEYS[@]} id
  for id in "${"$"}{KEYS[@]}"; do
    if [[ -s "$STATE_DIR/$id.pem" && "$id" != tmp-* ]]; then
      echo "$id $(stat -f %m "$STATE_DIR/$id.pem" 2>/dev/null || echo 0)"
    fi
  done | sort -k2 -nr | head -n "$count"
}
rotate() {
  cat > "key.json" <<'json'
{ "note": "$not_expanded" }
json
  if (( $(ls -1 key-*.pem | wc -l) > KEEP )); then
    ls -1t key-*.pem | tail -n +$((KEEP + 1)) | xargs rm -f --
  fi
  log "now ${"`"}ls -1 | wc -l${"`"} keys; it's done" a#b $#
  aws s3 cp --quiet \
    src "$dst" &&
    echo copied
}
case "$1" in
  status) newest; exit 0 ;;
  -h | --help) usage ;;
  *) echo "unknown: $1" >&2; exit 2 ;;
esac`.split("\n");
  let st = null;
  const got = script.map((line) => { const t = tokenize(line, "shell", st); st = t.state; return t.spans.map((s) => [line.slice(s.start, s.end), s.kind]); });
  const at = (start) => got[script.findIndex((l) => l.trimStart().startsWith(start))];
  const want = (start, ...pairs) => { for (const p of pairs) assert.ok(at(start).some(([t, k]) => t === p[0] && k === p[1]), `${start}: ${JSON.stringify(p)} in ${JSON.stringify(at(start))}`); };
  const none = (start, text, kind) => assert.ok(!at(start).some(([t, k]) => t.includes(text) && k === kind), `${start}: no ${kind} ${text} in ${JSON.stringify(at(start))}`);
  assert.equal(st, null, "nothing is left open at the end");
  assert.deepEqual(got[0], [["#!/usr/bin/env bash", "comment"]]);
  want("set", ["set", "keyword"], ["-euo", "type"]);
  want("readonly", ["readonly", "keyword"], ["QUEUE", "constant"], ["=", "operator"]);
  want("KEEP=3", ["KEEP", "constant"], ["3", "number"]);
  want("STATE_DIR", ["STATE_DIR", "constant"], ["${STATE_DIR:-$HOME/.cache/rotate-$QUEUE}", "constant"]); // inside the quotes
  want("declare", ["-a", "type"], ["KEYS", "constant"]); none("declare", "primary", "function");
  want("url=", ["# the fragment is no comment", "comment"]); none("url=", "#latest", "comment");
  want("log()", ["log", "function"], ["printf", "function"], ["'%s %s\\n'", "string"], ["$(", "operator"], ["date", "function"], ["-u", "type"], ["$*", "constant"], [">&2", "operator"]);
  want("function usage", ["function", "keyword"], ["usage", "function"]);
  want("cat <<-EOF", ["cat", "function"], ["<<-EOF", "keyword"]);
  want("usage: $0", ["$0", "constant"], ["\tusage: ", "string"]); // the heredoc's body
  assert.deepEqual(at("EOF"), [["\tEOF", "keyword"]]);
  want("local count", ["local", "keyword"], ["count", "constant"], ["${#KEYS[@]}", "constant"], ["id", "constant"]); none("local count", "#KEYS", "comment");
  want("for id", ["for", "keyword"], ["id", "constant"], ["in", "keyword"], ["do", "keyword"]);
  want("if [[", ["if", "keyword"], ["[[", "keyword"], ["-s", "type"], ["$id", "constant"], ["&&", "operator"], ["!=", "operator"], ["]]", "keyword"], ["then", "keyword"]);
  want("echo \"$id", ["echo", "function"], ["stat", "function"], ["2>", "operator"], ["||", "operator"], ["0", "number"]);
  assert.equal(at("echo \"$id").filter(([t, k]) => t === "echo" && k === "function").length, 2, "a command again after ||");
  want("done |", ["done", "keyword"], ["|", "operator"], ["sort", "function"], ["head", "function"], ["-n", "type"]);
  want("cat > \"key.json\"", [">", "operator"], ["<<'json'", "keyword"]);
  assert.deepEqual(at("{ \"note\""), [['{ "note": "$not_expanded" }', "string"]]); // a quoted marker: "$" stays text
  assert.deepEqual(at("json"), [["json", "keyword"]]); // a marker in small letters
  want("if ((", ["((", "keyword"], ["ls", "function"], ["wc", "function"], ["))", "keyword"]); none("if ((", "KEEP", "function");
  want("ls -1t", ["tail", "function"], ["xargs", "function"], ["1", "number"], ["--", "type"]); none("ls -1t", "rm", "function");
  want("log \"now", ["log", "function"], ["`", "operator"], ["ls", "function"], ["wc", "function"], [" keys; it's done\"", "string"], ["$#", "constant"]); none("log \"now", "a#b", "comment");
  none("src", "src", "function"); want("src", ["$dst", "constant"], ["&&", "operator"]); // "\" before it: arguments go on
  want("echo copied", ["echo", "function"]); // "&&" before it: a command
  want("case", ["case", "keyword"], ["in", "keyword"]);
  want("status)", ["status", "string"], ["newest", "function"], ["exit", "keyword"], [";;", "operator"]);
  want("-h |", ["-h | --help", "string"], ["usage", "function"]);
  want("*)", ["*", "string"], ["echo", "function"], [">&2", "operator"], ["2", "number"]);
  // Lines of their own: what stays open, and what must not hang or mislead.
  assert.deepEqual(tokenize("echo 'two", "shell").state, { s: "'", k: false });
  assert.equal(tokenize("lines' | wc", "shell", { s: "'", k: false }).state, null);
  assert.deepEqual(tokenize('x="$(aws sts get-caller-identity \\', "shell").state, { s: '"(', k: true });
  has('  --query Account)" && echo ok', "shell", ["echo", "function"], { s: '"(', k: true });
  assert.deepEqual(tokenize("cat <<EOF | grep x", "shell").state, { h: "EOF", raw: false, tabs: false, s: "" });
  assert.equal(tokenize("id=$(org list-parents --child-id \"$id\")", "shell").state, null); // "$(" outside quotes hung the old tokenizer
  has("id=$(org list-parents)", "shell", ["org", "function"]);
  has('AWS_PROFILE="$p" aws s3 ls', "shell", ["aws", "function"]);
  has("for ((i = 0; i < 10; i++)); do echo $i; done", "shell", ["echo", "function"]);
  has("POLICIES=(one two)", "shell", ["POLICIES", "constant"]);
  assert.ok(!kinds("POLICIES=(one two)", "shell").some(([, k]) => k === "function"));
  has("\t$(CC) -o $@ $<", "shell", ["-o", "type"]); // a Makefile recipe
  has("RUN apt-get update && apt-get install -y curl", "dockerfile", ["-y", "type"]);
  has("```sh", "markdown", ["```sh", "punctuation"], "md");
  has("echo $HOME", "markdown", ["echo", "function"], tokenize("```bash", "markdown", "md").state);
  assert.deepEqual(kinds("#!/usr/bin/env node", "js"), [["#!/usr/bin/env node", "comment"]]);
  assert.ok(kinds("#![allow(dead_code)]", "rust").length > 1); // an attribute, no "#!" line
}
has("SELECT id, name FROM users WHERE id = 1 -- x", "sql", ["SELECT", "keyword"]);
has("select id from t", "sql", ["from", "keyword"]);
has("FROM node:20 AS build", "dockerfile", ["AS", "keyword"]);
has('RUN npm ci && echo "ok"', "dockerfile", ["RUN", "keyword"]);
assert.deepEqual(tokenize("RUN a \\", "dockerfile").state, { cont: 1 });
has("#include <vector>", "cpp", ["#include", "keyword"]);
has("#include <vector>", "cpp", ["<vector>", "string"]);
has("template <typename T> class Foo : public Bar {", "cpp", ["Foo", "type"]);
has("std::vector<int> v = make(1);", "cpp", ["vector", "variable"]);
has("std::vector<int> v = make(1);", "cpp", ["make", "function"]);
r = tokenize('auto s = R"x(raw', "cpp");
assert.deepEqual(r.state, { end: ')x"' });
assert.equal(tokenize('more)x"; int y;', "cpp", r.state).state, null);
assert.deepEqual(tokenize("x", "nope"), { spans: [], state: null });

// Markdown: headings, fences in their language, links with href, inline code, emphasis, lists, front matter.
has("## Setup", "markdown", ["## Setup", "keyword"]);
const link = tokenize("See [the docs](../docs/a.md#install) and https://x.io.", "markdown", "md").spans.filter((s) => s.href);
assert.deepEqual(link.map((s) => s.href), ["../docs/a.md#install", "../docs/a.md#install", "https://x.io."]);
has("Use `npm ci` and **care**, not snake_case_name", "markdown", ["`npm ci`", "string"], "md");
has("Use `npm ci` and **care**, not snake_case_name", "markdown", ["**care**", "type"], "md");
assert.ok(!kinds("not snake_case_name here", "markdown", "md").length);
has("- [x] done", "markdown", ["-", "operator"], "md");
r = tokenize("```ts", "markdown", "md");
assert.equal(r.state.lang, "js");
has("const x = 1", "markdown", ["const", "keyword"], r.state);
assert.equal(tokenize("```", "markdown", r.state).state, null);
const fm = highlightLines(["---", "title: Hi", "---", "# Head"], "markdown");
assert.equal(fm[1][0].kind, "function");
assert.equal(fm[3][0].kind, "keyword");

// Diff rows: each side keeps its own state; hunk headers reset.
const rows = [{ kind: "@", text: "@@" }, { kind: "-", text: "/* old" }, { kind: "+", text: "let a = 1" }, { kind: " ", text: "b */ c" }, { kind: "@", text: "@@" }, { kind: "+", text: "x */" }];
const hl = highlightRows(rows, "js", "a.js");
assert.equal(hl[1][0].kind, "comment");
assert.equal(hl[2][0].kind, "keyword"); // new side never saw "/* old"
assert.notEqual(hl[3][0].kind, "comment"); // context row follows the new side's state
assert.notEqual(hl[5][0]?.kind, "comment"); // reset at "@"
assert.equal(highlightRows(rows, "js", "a.js"), hl); // memoized
assert.deepEqual(highlightRows(rows, null), rows.map(() => []));

// Colors: theme ANSI kept when readable, replaced when not.
const dark = { background: "#21252b", foreground: "#abb2bf", dim: "#5c6370", muted: "#7f848e", ansi1: "#e06c75", ansi2: "#98c379", ansi3: "#e5c07b", ansi4: "#61afef", ansi5: "#c678dd", ansi6: "#56b6c2", ansi14: "#56b6c2" };
const c = colors(dark);
assert.equal(c.keyword, "#c678dd");
const light = { ...dark, background: "#ffffff", foreground: "#1f2328", ansi3: "#f0f000" }; // unreadable yellow on white
const cl = colors(light);
assert.notEqual(cl.type, "#f0f000");
for (const [k, v] of Object.entries(cl)) if (k !== "comment") assert.ok(contrast(v, "#ffffff") >= 3, `${k} ${v}`);

// Runs: same-color neighbours merge, ref spans stay alone, text is covered exactly.
const line = "foo.bar(x) + 1";
const rs = runs(line, tokenize(line, "js").spans, c);
assert.equal(rs.map((x) => x.text).join(""), line);
assert.ok(rs.find((x) => x.text === "bar" && x.span?.ref));
const els = renderLine(() => { const e = { calls: [], child(t) { e.text = t; return e; } }; for (const m of ["flex_none", "whitespace_nowrap", "text_color"]) e[m] = () => e; return e; }, line, tokenize(line, "js").spans, c, (el, run) => ({ ...el, ref: run.text }));
assert.ok(els.some((e) => e.ref === "bar"));
assert.equal(line.slice(refAt(tokenize(line, "js").spans, 5).start, refAt(tokenize(line, "js").spans, 5).end), "bar");
assert.equal(refAt(tokenize(line, "js").spans, 11), null);

// Performance: 10k lines of mixed code.
const sample = ['import { a, b } from "./x.js";', "export function foo(bar, baz) {", "  const q = bar.map((x) => x * 2).filter(Boolean); // note",
  "  /* block */ return new Thing(q, `tpl ${baz}`);", "}", "class Thing extends Base { constructor(a, b) { super(a); this.b = b ?? 0x1f; } }"];
const big = Array.from({ length: 10000 }, (_, i) => ({ kind: i % 7 === 0 ? "-" : i % 5 === 0 ? "+" : " ", text: sample[i % sample.length] }));
const py = Array.from({ length: 10000 }, (_, i) => ({ kind: " ", text: ['def f(x: int) -> "Foo":', '    return {"a": [1, 2.5, None]}  # c', "    s = f'{x!r}' + other.call(y)"][i % 3] }));
highlightRows(big.slice(0, 500), "js"); // warm up the JIT
const sh = Array.from({ length: 10000 }, (_, i) => ({ kind: " ", text: ['if [[ -s "$STATE_DIR/$id.pem" && "$id" != tmp-* ]]; then', '  echo "$id $(stat -f %m "$STATE_DIR/$id.pem" 2>/dev/null || echo 0)" | sort -k2 -nr # c', "  KEEP=$((KEEP + 1)); log 'done' >&2", "fi"][i % 4] }));
for (const [name, set, lang] of [["js", big, "js"], ["python", py, "python"], ["shell", sh, "shell"]]) {
  // Best of three, so a busy machine (parallel test runs, model calls) does not fail a fast tokenizer.
  let ms = Infinity;
  for (let i = 0; i < 3 && ms >= 150; i++) {
    const t0 = performance.now();
    highlightRows(set, lang);
    ms = Math.min(ms, performance.now() - t0);
  }
  console.log(`tokenize 10k ${name} lines: ${ms.toFixed(1)} ms`);
  assert.ok(ms < 150, `${name} too slow: ${ms} ms`);
}
const t1 = performance.now();
highlightRows(big, "js", "big.js"); highlightRows(big, "js", "big.js");
console.log(`10k lines, memoized second call included: ${(performance.now() - t1).toFixed(1)} ms`);
// Sliced highlighting gives the same spans as one pass, whatever the slice size (a negative budget stops every 32 rows).
{
  const rows = Array.from({ length: 200 }, (_, i) => ({ kind: i % 7 === 0 ? "-" : i % 5 === 0 ? " " : "+", text: i % 9 === 0 ? "/* open" : i % 9 === 3 ? "close */ const x = 1;" : `let v${i} = "s";` }));
  const job = highlightJob(rows, "js");
  let out = null, steps = 0;
  while (!(out = highlightStep(job, -1))) steps++;
  assert.deepEqual(out, highlightRows(rows, "js"));
  assert.ok(steps >= 5, `${steps} slices`);
}
console.log("syntax ok");
