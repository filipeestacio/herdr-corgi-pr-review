// Syntax highlighting for diff lines, no dependencies. tokenize(line, lang, state) -> {spans, state}:
// spans are [{start, end, kind, ref?, href?}] in UTF-16 offsets; kind is one of the Editor's semantic names
// (keyword string comment function type number constant variable operator punctuation boolean). `ref: true` marks
// names worth a go-to-definition (types, called functions, members, Markdown links). `state` carries block comments,
// multi-line strings, heredocs and Markdown fences from one line to the next of the same file side.
// langOf(path, first) names the language: by the path, else by the file's first line (a "#!" line).
// Pure module: no gpui import, so `node test_syntax.mjs` can load it.

const words = (s) => new Set(s.split(" ").filter(Boolean));
const C_OPS = { line: ["//"], block: ["/*", "*/"] };
const SPECS = {
  js: { ...C_OPS, quotes: "'\"`", multi: ["`"], defType: "class interface type enum namespace", defFn: "function",
    kw: "break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new return super switch this throw try typeof var void while with yield async await as of static get set type interface enum implements private protected public readonly declare namespace abstract keyof infer is satisfies module",
    consts: "null undefined NaN Infinity", types: "string number boolean any unknown never void object symbol bigint" },
  python: { line: ["#"], quotes: "'\"", multi: ['"""', "'''"], prefixes: true, decorators: "function", defType: "class", defFn: "def",
    kw: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case",
    consts: "None self cls", bools: "True False", types: "int str float bool list dict set tuple bytes object type" },
  java: { ...C_OPS, quotes: "'\"", multi: ['"""'], decorators: "type", defType: "class interface enum record", defFn: "",
    kw: "abstract assert break case catch class continue default do else enum extends final finally for if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized this throw throws transient try volatile while var record sealed permits yield",
    consts: "null", types: "int long short byte char float double boolean void" },
  kotlin: { ...C_OPS, quotes: "'\"", multi: ['"""'], decorators: "type", defType: "class interface object typealias", defFn: "fun",
    kw: "as break class continue do else for fun if in interface is object package return super this throw try typealias val var when while by catch constructor data enum finally get import init internal lateinit open override private protected public sealed set suspend companion inline reified",
    consts: "null", types: "Int Long Short Byte Char Float Double Boolean Unit String Any Nothing" },
  cpp: { ...C_OPS, quotes: "'\"", preproc: true, rawStrings: true, defType: "class struct enum union namespace concept", defFn: "",
    kw: "alignas alignof asm auto break case catch class const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do dynamic_cast else enum explicit export extern final for friend goto if import inline module mutable namespace new noexcept operator override private protected public register reinterpret_cast requires return sizeof static static_assert static_cast struct switch template this thread_local throw try typedef typeid typename union using virtual volatile while concept",
    consts: "nullptr NULL", types: "void bool char char8_t char16_t char32_t wchar_t short int long float double signed unsigned size_t ssize_t ptrdiff_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t byte boolean word" },
  go: { ...C_OPS, quotes: "'\"`", multi: ["`"], defType: "type", defFn: "func",
    kw: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
    consts: "nil iota", types: "bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any" },
  rust: { ...C_OPS, quotes: "\"", lifetimes: true, macros: true, defType: "struct enum trait type union mod", defFn: "fn",
    kw: "as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
    consts: "None", types: "i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str" },
  hcl: { line: ["#", "//"], block: ["/*", "*/"], quotes: "\"", heredoc: true, keys: "variable", defType: "", defFn: "",
    kw: "resource data module variable output locals provider terraform for in if for_each count depends_on lifecycle dynamic content backend required_providers moved import check",
    consts: "null" },
  sql: { line: ["--"], block: ["/*", "*/"], quotes: "'", nocase: true, defType: "table view", defFn: "function",
    kw: "select from where and or not insert into values update set delete create table alter drop index join left right inner outer full cross on group by order having limit offset as distinct union all is in exists between like ilike case when then else end primary key foreign references default with returning begin commit rollback view if replace function returns language asc desc unique constraint add column cascade grant revoke",
    consts: "null", types: "int integer smallint bigint serial bigserial varchar char text boolean bool timestamp timestamptz date time interval uuid json jsonb numeric decimal real float double" },
  yaml: { line: ["#"], quotes: "'\"", keys: "function", consts: "null ~", bools: "true false yes no on off True False", kw: "" },
  json: { quotes: "\"", keys: "function", consts: "null", kw: "" },
};
for (const s of Object.values(SPECS)) {
  for (const k of ["kw", "consts", "types"]) s[k] = words(s[k] ?? "");
  s.bools = words(s.bools ?? "true false");
  s.defType = words(s.defType ?? "");
  s.defFn = words(s.defFn ?? "");
}

const EXT = { ts: "js", tsx: "js", mts: "js", cts: "js", js: "js", jsx: "js", mjs: "js", cjs: "js", py: "python", pyi: "python",
  java: "java", c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", ino: "cpp", kt: "kotlin", kts: "kotlin", go: "go", rs: "rust", tf: "hcl", tfvars: "hcl", hcl: "hcl", yml: "yaml", yaml: "yaml",
  toml: "yaml", json: "json", jsonc: "json", sh: "shell", bash: "shell", zsh: "shell", md: "markdown", markdown: "markdown",
  sql: "sql", dockerfile: "dockerfile",
  // Shell by another name; fish, make and just are close enough for comments, strings, variables and commands.
  ksh: "shell", fish: "shell", bats: "shell", command: "shell", mk: "shell", just: "shell", envrc: "shell", profile: "shell",
  bashrc: "shell", zshrc: "shell", zshenv: "shell", zprofile: "shell", bash_profile: "shell", bash_aliases: "shell", bash_logout: "shell" };
const TEMPLATE = /\.(?:tpl|tftpl|tmpl|j2|erb|in|example|sample|dist)$/; // deploy.sh.tpl is a shell script with holes
const INTERPRETER = { sh: "shell", bash: "shell", zsh: "shell", dash: "shell", ksh: "shell", ash: "shell", fish: "shell", bats: "shell",
  python: "python", pypy: "python", uv: "python", node: "js", nodejs: "js", deno: "js", bun: "js", tsx: "js", "ts-node": "js" };
const HOOK_DIR = /(?:^|\/)(?:hooks|\.husky|\.githooks)\/[a-z-]+$/; // Git hooks carry no ending

/** Highlighter language for a path (null: plain text). `first` is the file's first line where the caller has it: a
 *  script without an ending is known by its "#!" line (firstLineOf reads it from a diff). */
export function langOf(path, first = "") {
  const name = path.split("/").pop().toLowerCase().replace(TEMPLATE, "");
  if (name === "dockerfile" || name.startsWith("dockerfile.") || name.endsWith(".dockerfile")) return "dockerfile";
  if (name === "makefile" || name === "gnumakefile" || name === "justfile" || name.endsWith(".env") || name.startsWith(".env.")) return "shell";
  const known = EXT[name.includes(".") ? name.split(".").pop() : ""];
  if (known) return known;
  if (first.charCodeAt(0) === 35 && first.charCodeAt(1) === 33) { // "#!/usr/bin/env -S python3 -u", "#!/bin/sh -e"
    const [prog, ...args] = first.slice(2).trim().split(/\s+/), base = prog.split("/").pop();
    const run = base === "env" ? args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? "" : base;
    return INTERPRETER[run.split("/").pop().replace(/[\d.]+$/, "")] ?? null;
  }
  return HOOK_DIR.test(path.toLowerCase()) ? "shell" : null;
}

/** What a file's diff says beyond its path, for langOf. `lines`: the file's part of a patch (its header lines and
 *  hunks; splitPatch's `lines`). Line 1 where the first hunk shows it; "#!sh" for an executable file (git mode 100755)
 *  whose line 1 the diff does not show.
 *  ponytail: most executable files without an ending are shell scripts; reading line 1 from the checkout would say
 *  for sure, if a Python or Ruby script coloured as shell ever matters. */
export function firstLineOf(lines) {
  let exec = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.charCodeAt(0) === 64) { // "@@ -1,4 +1,6 @@": the hunks come in order, so the first one decides
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
      if (m && (m[1] === "1" || m[2] === "1") && lines[i + 1] !== undefined) return lines[i + 1].slice(1);
      break;
    }
    if (/^(?:new file mode|deleted file mode|new mode|index \S+) 100755$/.test(l)) exec = true;
  }
  return exec ? "#!sh" : "";
}

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUM = /0[xX][\da-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+|(?:\d[\d_]*(?:\.\d[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?[a-zA-Z]*/y;
const PUNCT = "{}[]();,.";
const PYPREFIX = /[rRbBfFuU]{1,2}(?=['"])/y, RUST_CHAR = /'(?:\\.|[^'\\])'/y, RUST_LT = /'[A-Za-z_]\w*/y;
const PREPROC = /\s*#\s*[a-z]+/y, INCLUDE = /\s*<[^>]*>/y, RAW = /R"([^(\s"\\]{0,16})\(/y;
const HEREDOC = /<<-?(\w+)\s*$/y, SHVAR = /\$(?:\{[^}]*\}|[A-Za-z_]\w*|[0-9@*#?$!-])/y;
const OPS = "+-*/%=<>!&|^~?:";
const isSpace = (c) => c === 32 || c === 9;
const isDigit = (c) => c >= 48 && c <= 57;
const isIdStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
const pascal = (w) => /^[A-Z][A-Z0-9]*[a-z]/.test(w);
const allCaps = (w) => w.length > 1 && /^[A-Z][A-Z0-9_]*$/.test(w);

/** One line -> {spans, state}. `state` is null at the start of a file (or after a gap). */
export function tokenize(line, lang, state = null) {
  if (lang === "markdown") return markdown(line, state);
  if (lang === "dockerfile") return dockerfile(line, state);
  if (lang === "shell") return shell(line, state, 0, []);
  const spec = SPECS[lang];
  if (!spec) return { spans: [], state: null };
  // A script's "#!/usr/bin/env node" line is no code of its language (Rust's "#![attr]" is).
  if (line.charCodeAt(0) === 35 && line.charCodeAt(1) === 33 && line.charCodeAt(2) !== 91) return { spans: [{ start: 0, end: line.length, kind: "comment" }], state };
  return scan(line, spec, state, 0, []);
}

// Scans line[from..] with spec, appending to spans.
function scan(line, spec, state, from, spans) {
  const n = line.length, push = (start, end, kind, extra) => { if (end > start) spans.push(extra ? { start, end, kind, ...extra } : { start, end, kind }); };
  let i = from;
  // Continue a construct left open on the previous line.
  if (state) {
    if (state.h) { // heredoc: ends on a line that is just the marker
      if (line.trim() === state.h) { push(0, n, "keyword"); return { spans, state: null }; }
      push(0, n, "string"); return { spans, state };
    }
    const end = line.indexOf(state.end, i);
    const kind = state.c ? "comment" : "string";
    if (end < 0) { push(i, n, kind); return { spans, state }; }
    push(i, end + state.end.length, kind);
    i = end + state.end.length;
    state = null;
  }
  if (spec.preproc) {
    PREPROC.lastIndex = i;
    if (PREPROC.test(line)) {
      push(line.indexOf("#", i), PREPROC.lastIndex, "keyword"); i = PREPROC.lastIndex;
      INCLUDE.lastIndex = i;
      if (INCLUDE.test(line)) { push(line.indexOf("<", i), INCLUDE.lastIndex, "string"); i = INCLUDE.lastIndex; }
    }
  }
  let prevWord = "", prevChar = 0;
  while (i < n) {
    const c = line.charCodeAt(i);
    if (isSpace(c)) { i++; continue; }
    const ch = line[i];
    // Comments.
    if (spec.line && spec.line.some((p) => line.startsWith(p, i))) { push(i, n, "comment"); break; }
    if (spec.block && line.startsWith(spec.block[0], i)) {
      const end = line.indexOf(spec.block[1], i + 2);
      if (end < 0) { push(i, n, "comment"); return { spans, state: { c: 1, end: spec.block[1] } }; }
      push(i, end + 2, "comment"); i = end + 2; prevChar = 0; continue;
    }
    // Strings (with Python prefixes like f"", rb'').
    let q = -1;
    if (spec.quotes.includes(ch)) q = i;
    else if (spec.prefixes && "rRbBfFuU".includes(ch)) { PYPREFIX.lastIndex = i; if (PYPREFIX.test(line)) q = PYPREFIX.lastIndex; }
    if (q >= 0) {
      const multi = spec.multi?.find((m) => line.startsWith(m, q));
      if (multi) {
        const end = line.indexOf(multi, q + multi.length);
        if (end < 0) { push(i, n, "string"); return { spans, state: { end: multi } }; }
        push(i, end + multi.length, "string"); i = end + multi.length; prevChar = 0; continue;
      }
      {
        const quote = line[q]; let j = q + 1;
        while (j < n && line[j] !== quote) j += line[j] === "\\" && quote !== "`" ? 2 : 1;
        const end = Math.min(j + 1, n);
        // JSON/YAML keys: a string followed by ":".
        const key = spec.keys && /^\s*:/.test(line.slice(end, end + 8));
        push(i, end, key ? spec.keys : "string"); i = end; prevChar = 0; continue;
      }
    }
    if (spec.rawStrings && ch === "R" && line[i + 1] === '"') { // C++ R"delim( ... )delim"
      RAW.lastIndex = i;
      if (RAW.test(line)) {
        const close = `)${/R"([^(]*)\(/.exec(line.slice(i))[1]}"`, end = line.indexOf(close, RAW.lastIndex);
        if (end < 0) { push(i, n, "string"); return { spans, state: { end: close } }; }
        push(i, end + close.length, "string"); i = end + close.length; continue;
      }
    }
    if (spec.lifetimes && ch === "'") { // Rust: 'x' char literal or 'a lifetime
      RUST_CHAR.lastIndex = i;
      if (RUST_CHAR.test(line)) { push(i, RUST_CHAR.lastIndex, "string"); i = RUST_CHAR.lastIndex; continue; }
      RUST_LT.lastIndex = i;
      if (RUST_LT.test(line)) { push(i, RUST_LT.lastIndex, "type"); i = RUST_LT.lastIndex; continue; }
    }
    if (spec.heredoc && line.startsWith("<<", i)) {
      HEREDOC.lastIndex = i;
      if (HEREDOC.test(line)) { push(i, n, "keyword"); return { spans, state: { h: /<<-?(\w+)/.exec(line.slice(i))[1] } }; }
    }
    if (spec.decorators && ch === "@") {
      IDENT.lastIndex = i + 1;
      if (IDENT.test(line)) { push(i, IDENT.lastIndex, spec.decorators, { ref: true }); i = IDENT.lastIndex; continue; }
    }
    if (isDigit(c) || (ch === "." && isDigit(line.charCodeAt(i + 1)))) {
      NUM.lastIndex = i;
      if (NUM.test(line)) { push(i, NUM.lastIndex, "number"); i = NUM.lastIndex; prevChar = 0; continue; }
    }
    if (isIdStart(c)) {
      IDENT.lastIndex = i;
      IDENT.test(line);
      const end = IDENT.lastIndex, w = line.slice(i, end), lw = spec.nocase ? w.toLowerCase() : w;
      let j = end; while (j < n && isSpace(line.charCodeAt(j))) j++;
      const next = line[j], member = prevChar === 46 || (prevChar === 58 && line[i - 2] === ":"); // "." or "::"
      let kind = null, ref = false;
      if (spec.keys && ((next === "=" && line[j + 1] !== "=") || (spec.keys !== "variable" && next === ":"))) kind = spec.keys;
      else if (!member && spec.kw.has(lw)) kind = "keyword";
      else if (spec.bools.has(lw)) kind = "boolean";
      else if (!member && spec.consts.has(lw)) kind = "constant";
      else if (spec.types.has(lw)) kind = "type";
      else if (spec.defType.has(prevWord)) { kind = "type"; ref = true; }
      else if (spec.defFn.has(prevWord)) { kind = "function"; ref = true; }
      else if (spec.macros && next === "!" && line[j + 1] !== "=") { kind = "function"; ref = true; }
      else if (next === "(") { kind = prevWord === "new" && pascal(w) ? "type" : "function"; ref = true; }
      else if (pascal(w)) { kind = "type"; ref = true; }
      else if (allCaps(w)) { kind = "constant"; ref = true; }
      else if (member) { kind = "variable"; ref = true; }
      if (kind) push(i, end, kind, ref ? { ref: true } : null);
      prevWord = lw; prevChar = line.charCodeAt(end - 1); i = end; continue;
    }
    push(i, i + 1, PUNCT.includes(ch) ? "punctuation" : OPS.includes(ch) ? "operator" : "punctuation");
    prevChar = c; if (ch !== "." && ch !== ":") prevWord = "";
    i++;
  }
  return { spans, state: null };
}

// Shell has its own scanner: a word is a command or an argument by its place, "#" opens a comment only at the start
// of a word, quotes hold "$var" and "$(…)", and a heredoc starts on the line after its "<<EOF".
// state (null: nothing open): {s, h, raw, tabs, k}. s: what is still open, innermost last, one character each:
// "'" '"' "$" ($'…') strings, "(" "`" command lists, "a" an array's words, "m" "p" arithmetic and a bracket in it.
// h: the marker of a heredoc whose body follows (raw: quoted marker, "$" stays text; tabs: "<<-", the marker may be
// indented). k: the line ended in "\", so the next one goes on with arguments.
const SH_KW = words("if then else elif fi for while until do done case esac in function select time return local export readonly declare typeset set unset shift exit source alias break continue trap eval exec end begin switch");
const SH_GOES_ON = words("if then else elif do while until time exec eval"), SH_DECL = words("local export readonly declare typeset alias");
const SH_WORD = /(?:[^\s;|&()<>'"`$\\]|\\.)+/y, SH_ASSIGN = /[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/y, SH_FN = /[ \t]*\([ \t]*\)/y;
const SH_REDIR = /(?:&>>?|\d*(?:>>|<<<|[<>]&|<>|>\||[<>]))[\d-]?/y, SH_HERE = /<<(-?)[ \t]*(?:(['"])([^'"]+)\2|(\\?)([\w.-]+))/y;
const SH_PATTERN = /[ \t]*[^\s()|;&<>]+(?:[ \t]*\|[ \t]*[^\s()|;&<>]+)*\)/y; // "-h | --help)" of a case
const SH_OPTION = /^-{1,2}[A-Za-z0-9?][\w-]*|^--$|^\+[a-z]$/, SH_NAME = /^[A-Za-z_]\w*$/, SH_NUMBER = /^(?:0x[\da-f]+|\d+(?:\.\d+)?)$/i, SH_TEST = /^[!=~+*\/%:<>-]+$/;
function shell(line, state, from, spans) {
  const n = line.length, push = (start, end, kind, ref) => { if (end > start) spans.push(ref ? { start, end, kind, ref: true } : { start, end, kind }); };
  // Text of a string where "$name" and "${…}" stand out.
  const text = (a, b) => {
    let at = a;
    for (let j = line.indexOf("$", a); j >= 0 && j < b; j = line.indexOf("$", j + 1)) {
      SHVAR.lastIndex = j;
      if (line.charCodeAt(j - 1) === 92 || !SHVAR.test(line)) continue;
      const end = Math.min(SHVAR.lastIndex, b);
      push(at, j, "string"); push(j, end, "constant"); at = end; j = end - 1;
    }
    push(at, b, "string");
  };
  if (state?.h) { // a heredoc's body, up to the line that is just its marker
    if ((state.tabs ? line.trim() : line.trimEnd()) === state.h) { push(0, n, "keyword"); return { spans, state: state.s ? { s: state.s } : null }; }
    if (state.raw) push(0, n, "string"); else text(0, n);
    return { spans, state };
  }
  const open = state?.s ? state.s.split("") : [];
  let i = from, here = null, goesOn = false;
  // first: the next word is a command (again: it is one again after the value of NAME="…" at this depth). decl: after "local"/"export", where name=value pairs follow. name: the next word
  // names a function ("f") or a loop variable ("v"). wantIn: a "for" or "case" waits for its "in". pattern: a case
  // pattern may start here.
  let first = !state?.k, again = -1, decl = false, name = "", wantIn = "", pattern = open.length === 0 && first;
  while (i < n) {
    const top = open.length ? open[open.length - 1] : "", c = line.charCodeAt(i);
    if (top === "'" || top === "$") { // a quote from an earlier line
      let j = i;
      while (j < n && line.charCodeAt(j) !== 39) j += top === "$" && line.charCodeAt(j) === 92 ? 2 : 1;
      if (j >= n) { push(i, n, "string"); i = n; break; }
      push(i, j + 1, "string"); i = j + 1; open.pop(); first = false; continue;
    }
    if (top === '"') { // up to the closing quote, or to a "$(" or "`" whose inside is code again
      let j = i;
      for (;;) {
        if (j >= n) { text(i, n); i = n; break; }
        const d = line.charCodeAt(j);
        if (d === 92) { j += 2; continue; }
        if (d === 34) { text(i, j + 1); i = j + 1; open.pop(); first = false; break; }
        if (d === 36 && line.charCodeAt(j + 1) === 40) {
          text(i, j);
          if (line.charCodeAt(j + 2) === 40) { push(j, j + 1, "operator"); push(j + 1, j + 3, "keyword"); open.push("m"); i = j + 3; first = false; }
          else { push(j, j + 2, "operator"); open.push("("); i = j + 2; first = true; }
          break;
        }
        if (d === 96) { text(i, j); push(j, j + 1, "operator"); open.push("`"); i = j + 1; first = true; break; }
        if (d === 36) { SHVAR.lastIndex = j; if (SHVAR.test(line)) { j = SHVAR.lastIndex; continue; } } // a quote inside "${x:-"y"}" closes nothing
        j++;
      }
      continue;
    }
    if (isSpace(c)) { if (again === open.length) { first = true; again = -1; } i++; continue; }
    const math = top === "m" || top === "p";
    if (pattern) { // "status | list)" opens a case branch: its words are no command
      pattern = false; SH_PATTERN.lastIndex = i;
      if (!math && c !== 35 && SH_PATTERN.test(line)) { const end = SH_PATTERN.lastIndex; push(i, end - 1, "string"); push(end - 1, end, "punctuation"); i = end; first = true; continue; }
    }
    if (c === 35 && !math) { push(i, n, "comment"); i = n; break; } // "#": a word never starts here with one, so it is a comment
    if (c === 39) {
      const end = line.indexOf("'", i + 1);
      if (end < 0) { push(i, n, "string"); open.push("'"); i = n; break; }
      push(i, end + 1, "string"); i = end + 1; first = false; continue;
    }
    if (c === 34) { push(i, i + 1, "string"); open.push('"'); i++; first = false; continue; }
    if (c === 36) {
      const d = line.charCodeAt(i + 1);
      if (d === 40 && line.charCodeAt(i + 2) === 40) { push(i, i + 1, "operator"); push(i + 1, i + 3, "keyword"); open.push("m"); i += 3; first = false; continue; }
      if (d === 40) { push(i, i + 2, "operator"); open.push("("); i += 2; first = true; continue; }
      if (d === 39) { // $'…' with backslash escapes
        let j = i + 2;
        while (j < n && line.charCodeAt(j) !== 39) j += line.charCodeAt(j) === 92 ? 2 : 1;
        if (j >= n) { push(i, n, "string"); open.push("$"); i = n; break; }
        push(i, j + 1, "string"); i = j + 1; first = false; continue;
      }
      SHVAR.lastIndex = i;
      if (SHVAR.test(line)) { push(i, SHVAR.lastIndex, "constant"); i = SHVAR.lastIndex; first = false; continue; }
      i++; continue;
    }
    if (c === 96) { push(i, i + 1, "operator"); if (top === "`") { open.pop(); first = false; } else { open.push("`"); first = true; } i++; continue; }
    if (c === 40) {
      if (math) { open.push("p"); push(i, i + 1, "punctuation"); i++; continue; }
      if ((first || name === "v") && line.charCodeAt(i + 1) === 40) { push(i, i + 2, "keyword"); open.push("m"); i += 2; first = false; name = ""; continue; } // (( n > 1 )), for ((…))
      const array = line.charCodeAt(i - 1) === 61; // NAME=( … )
      push(i, i + 1, "punctuation"); open.push(array ? "a" : "("); first = !array; i++; continue;
    }
    if (c === 41) {
      if (top === "m" && line.charCodeAt(i + 1) === 41) { push(i, i + 2, "keyword"); open.pop(); i += 2; first = false; continue; }
      push(i, i + 1, "punctuation"); i++;
      if (top === "(" || top === "a" || top === "p") { open.pop(); first = false; } else if (!math) first = true; // no "(" before it: the end of a case pattern
      continue;
    }
    if (c === 59) { // ";" ends a command, ";;" a case branch
      const two = line.charCodeAt(i + 1) === 59;
      push(i, i + (two ? 2 : 1), two ? "operator" : "punctuation"); i += two ? 2 : 1;
      first = top !== "a" && !math; decl = false; name = ""; wantIn = ""; pattern = two; continue;
    }
    if (c === 60 && line.charCodeAt(i + 1) === 60 && line.charCodeAt(i + 2) !== 60 && !math) {
      SH_HERE.lastIndex = i;
      const m = SH_HERE.exec(line);
      if (m) { push(i, SH_HERE.lastIndex, "keyword"); here = { h: m[3] ?? m[5], raw: Boolean(m[2] || m[4]), tabs: m[1] === "-" }; i = SH_HERE.lastIndex; continue; }
    }
    if (c === 60 || c === 62 || c === 38 || isDigit(c)) { // redirections: 2>&1, >>file, <<<"$x", &>log
      SH_REDIR.lastIndex = i;
      if (!math && SH_REDIR.test(line)) { push(i, SH_REDIR.lastIndex, "operator"); i = SH_REDIR.lastIndex; continue; }
    }
    if (c === 124 || c === 38) { // | || |& & &&: another command follows
      const d = line.charCodeAt(i + 1), two = d === c || (c === 124 && d === 38);
      push(i, i + (two ? 2 : 1), "operator"); i += two ? 2 : 1;
      first = top !== "a" && !math; decl = false; continue;
    }
    if (c === 123 && (i + 1 >= n || isSpace(line.charCodeAt(i + 1)))) { push(i, i + 1, "punctuation"); i++; first = true; continue; } // "{ list; }"
    if (c === 125) { push(i, i + 1, "punctuation"); i++; first = false; continue; }
    if (c === 92 && i === n - 1) { goesOn = !first; i++; continue; } // "\" at the end: the command goes on in the next line
    SH_WORD.lastIndex = i;
    if (!SH_WORD.test(line)) { i++; continue; }
    let end = SH_WORD.lastIndex;
    const w = line.slice(i, end);
    if (math) { if (SH_NUMBER.test(w)) push(i, end, "number"); i = end; continue; }
    if (top === "a") { i = end; continue; }
    if (first || decl) { // NAME=value, NAME+=value, NAME[i]=value
      SH_ASSIGN.lastIndex = i;
      if (SH_ASSIGN.test(line) && SH_ASSIGN.lastIndex <= end) {
        const eq = SH_ASSIGN.lastIndex;
        push(i, eq - 1 - (line.charCodeAt(eq - 2) === 43 ? 1 : 0), "constant"); push(eq - 1 - (line.charCodeAt(eq - 2) === 43 ? 1 : 0), eq, "operator");
        if (eq < end && SH_NUMBER.test(line.slice(eq, end))) push(eq, end, "number");
        if (first && eq === end) again = open.length; // a quoted value or "$(…)" follows
        i = end; continue; // still at a command: "LANG=C sort"
      }
    }
    if (first) {
      first = false;
      if (w === "[[" || w === "[") push(i, end, "keyword");
      else if (w === "!") { push(i, end, "operator"); first = true; }
      else if (SH_KW.has(w)) {
        push(i, end, "keyword");
        if (SH_GOES_ON.has(w)) first = true;
        else if (SH_DECL.has(w)) decl = true;
        else if (w === "function") name = "f";
        else if (w === "for" || w === "select") { name = "v"; wantIn = "for"; }
        else if (w === "case") wantIn = "case";
      } else {
        SH_FN.lastIndex = end;
        if (SH_FN.test(line)) { push(i, end, "function", true); push(end, SH_FN.lastIndex, "punctuation"); end = SH_FN.lastIndex; first = true; } // name() {
        else push(i, end, "function", true);
      }
    } else if (name) { push(i, end, name === "f" ? "function" : "constant", name === "f"); first = name === "f"; name = ""; }
    else if (w === "in" && wantIn) { push(i, end, "keyword"); pattern = wantIn === "case"; wantIn = ""; }
    else if (w === "]]" || w === "]") push(i, end, "keyword");
    else if (decl && SH_NAME.test(w)) push(i, end, "constant"); // local name
    else if (SH_OPTION.test(w)) { const eq = w.indexOf("="); push(i, eq < 0 ? end : i + eq, "type"); }
    else if (SH_NUMBER.test(w)) push(i, end, "number");
    else if (SH_TEST.test(w)) push(i, end, "operator");
    i = end;
  }
  const s = open.join("");
  if (here) return { spans, state: { ...here, s } };
  return { spans, state: s || goesOn ? { s, k: goesOn } : null };
}

const DOCKER = /^(\s*)(FROM|RUN|CMD|COPY|ADD|ENV|ARG|WORKDIR|EXPOSE|ENTRYPOINT|USER|LABEL|VOLUME|HEALTHCHECK|SHELL|ONBUILD|STOPSIGNAL|MAINTAINER)\b/i;
function dockerfile(line, state) {
  if (state?.cont) { const r = shell(line, null, 0, []); return { spans: r.spans, state: /\\\s*$/.test(line) ? state : null }; }
  if (/^\s*#/.test(line)) return { spans: [{ start: 0, end: line.length, kind: "comment" }], state: null };
  const m = DOCKER.exec(line);
  if (!m) return { spans: [], state: null };
  const spans = [{ start: m[1].length, end: m[0].length, kind: "keyword" }];
  const as = / AS /i.exec(line);
  if (/^from$/i.test(m[2]) && as) spans.push({ start: as.index + 1, end: as.index + 3, kind: "keyword" });
  else shell(line, null, m[0].length, spans);
  return { spans, state: /\\\s*$/.test(line) ? { cont: 1 } : null };
}

// Markdown: front matter, headings, fences (highlighted in the fence's language), quotes, lists, tables, inline code,
// emphasis, links. Link spans carry `href`.
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/;
function markdown(line, state) {
  const n = line.length, spans = [];
  if (state?.fm) { // front matter
    if (/^(---|\.\.\.)\s*$/.test(line)) return { spans: [{ start: 0, end: n, kind: "punctuation" }], state: null };
    return { spans: scan(line, SPECS.yaml, null, 0, []).spans, state };
  }
  if (state?.fence) {
    const m = FENCE.exec(line);
    if (m && m[2][0] === state.fence[0] && m[2].length >= state.fence.length && !m[3]) return { spans: [{ start: 0, end: n, kind: "punctuation" }], state: null };
    if (!state.lang) return { spans: [{ start: 0, end: n, kind: "string" }], state };
    const r = tokenize(line, state.lang, state.inner);
    return { spans: r.spans, state: { ...state, inner: r.state } };
  }
  if (state === null && /^---\s*$/.test(line)) return { spans: [{ start: 0, end: n, kind: "punctuation" }], state: { fm: 1 } };
  const fence = FENCE.exec(line);
  if (fence) {
    spans.push({ start: 0, end: n, kind: "punctuation" });
    return { spans, state: { fence: fence[2], lang: fence[3] ? langOf(`x.${fence[3].toLowerCase()}`) ?? FENCE_LANG[fence[3].toLowerCase()] ?? null : null, inner: null } };
  }
  const h = /^\s{0,3}#{1,6}(\s|$)/.exec(line);
  if (h) return { spans: [{ start: 0, end: n, kind: "keyword" }], state: "md" };
  if (/^\s{0,3}>/.test(line)) { spans.push({ start: 0, end: line.indexOf(">") + 1, kind: "comment" }); inline(line, line.indexOf(">") + 1, spans); return { spans, state: "md" }; }
  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) return { spans: [{ start: 0, end: n, kind: "punctuation" }], state: "md" };
  const li = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s)?/.exec(line);
  let from = 0;
  if (li) { spans.push({ start: li[1].length, end: li[1].length + li[2].length, kind: "operator" }); from = li[0].length; if (li[4]) spans.push({ start: from - li[4].length, end: from - 1, kind: "constant" }); }
  inline(line, from, spans);
  return { spans, state: "md" };
}
const FENCE_LANG = { typescript: "js", javascript: "js", python: "python", golang: "go", rust: "rust", terraform: "hcl", shell: "shell", console: "shell", shellscript: "shell", make: "shell", makefile: "shell", docker: "dockerfile" };

const INLINE = /(`+)(.+?)\1|!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]]+)\]\[[^\]]*\]|<(https?:\/\/[^>\s]+)>|(?<!\w)(\*\*|__)(?=\S)(.+?\S)\7(?!\w)|(?<!\w)(\*|_)(?=\S)(.+?\S)\9(?!\w)|(\|)|https?:\/\/[^\s)>\]]+/g;
function inline(line, from, spans) {
  INLINE.lastIndex = from;
  for (let m; (m = INLINE.exec(line));) {
    const s = m.index, e = s + m[0].length;
    if (m[1]) spans.push({ start: s, end: e, kind: "string" });
    else if (m[4] !== undefined) {
      const textEnd = s + m[0].indexOf("](") + 1;
      spans.push({ start: s, end: textEnd, kind: "function", ref: true, href: m[4] });
      spans.push({ start: textEnd, end: e, kind: "string", ref: true, href: m[4] });
    } else if (m[5]) spans.push({ start: s, end: e, kind: "function" });
    else if (m[6]) spans.push({ start: s, end: e, kind: "string", ref: true, href: m[6] });
    else if (m[7]) spans.push({ start: s, end: e, kind: "type" });
    else if (m[9]) spans.push({ start: s, end: e, kind: "constant" });
    else if (m[11]) spans.push({ start: s, end: e, kind: "punctuation" });
    else spans.push({ start: s, end: e, kind: "string", ref: true, href: m[0] });
  }
}

// Diff rows -> spans per row, with one state per side: context and "+" rows continue the new side, context and "-"
// the old one. "@" (hunk header) rows reset both, since the lines between hunks are unknown.
// ponytail: a block comment opened in hidden lines starts uncolored; carrying it would need the full file.
const memo = new Map();
export function highlightRows(rows, lang, key = null) {
  if (!lang) return rows.map(() => EMPTY);
  const k = key === null ? null : `${key}\0${lang}\0${rows.length}\0${hashRows(rows)}`;
  if (k !== null && memo.has(k)) return memo.get(k);
  const out = highlightStep(highlightJob(rows, lang), Infinity);
  if (k !== null) { if (memo.size > 400) memo.delete(memo.keys().next().value); memo.set(k, out); }
  return out;
}
// The same highlighting a slice at a time, for files too big for one script slice (Herdr stops one after ~50 ms):
// highlightStep tokenizes for about `ms`, keeps its place in the job, and returns the spans once the last row is done
// (null until then). Old and new sides carry their own state, as in a diff.
export const highlightJob = (rows, lang) => ({ rows, lang, i: 0, olds: null, news: null, out: new Array(rows.length) });
export function highlightStep(job, ms = 10) {
  if (!job.lang) return job.rows.map(() => EMPTY);
  const end = Date.now() + ms;
  for (; job.i < job.rows.length; job.i++) {
    const r = job.rows[job.i];
    if (r.kind === "@") { job.olds = job.news = null; job.out[job.i] = EMPTY; }
    else if (r.kind === "-") { const t = tokenize(r.text ?? "", job.lang, job.olds); job.olds = t.state; job.out[job.i] = t.spans; }
    else {
      const t = tokenize(r.text ?? "", job.lang, job.news); job.news = t.state; job.out[job.i] = t.spans;
      if (r.kind !== "+") job.olds = tokenize(r.text ?? "", job.lang, job.olds).state; // context: both sides see it
    }
    if ((job.i & 31) === 31 && Date.now() > end) { job.i++; return null; }
  }
  return job.out;
}
/** The memoized result of highlightRows, or undefined when it still has to be computed (never tokenizes). */
export function cachedRows(rows, lang, key) {
  if (!lang) return rows.map(() => EMPTY);
  return memo.get(`${key}\0${lang}\0${rows.length}\0${hashRows(rows)}`);
}
/** Whole file (full-file view): spans per line. */
export const highlightLines = (lines, lang, key = null) => highlightRows(lines.map((text) => ({ kind: "+", text })), lang, key);
const EMPTY = Object.freeze([]);
function hashRows(rows) {
  let h = 0x811c9dc5;
  for (const r of rows) { const t = r.kind + (r.text ?? ""); for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193); h = Math.imul(h ^ 10, 0x01000193); }
  return (h >>> 0).toString(16);
}

// Colors: the theme's ANSI palette (tuned for t.background by the theme's author), each checked for contrast; a
// fixed One Dark / GitHub Light color replaces any that falls under 3:1.
const DARK = { keyword: "#c678dd", string: "#98c379", comment: "#7f848e", function: "#61afef", type: "#e5c07b", number: "#d19a66",
  constant: "#56b6c2", boolean: "#d19a66", operator: "#abb2bf", punctuation: "#8b929e", variable: "#e06c75", "string.escape": "#56b6c2" };
const LIGHT = { keyword: "#cf222e", string: "#0a3069", comment: "#6e7781", function: "#8250df", type: "#953800", number: "#0550ae",
  constant: "#0550ae", boolean: "#0550ae", operator: "#57606a", punctuation: "#57606a", variable: "#953800", "string.escape": "#0a3069" };
const FROM_THEME = { keyword: "ansi5", string: "ansi2", comment: "dim", function: "ansi4", type: "ansi3", number: "ansi6", constant: "ansi6",
  boolean: "ansi6", operator: "muted", punctuation: "muted", variable: "ansi1", "string.escape": "ansi14" };
let colorMemo = null;
export function colors(t, bg = t.background) {
  const key = `${bg}${t.foreground}${t.ansi1}${t.ansi2}${t.ansi3}${t.ansi4}${t.ansi5}${t.ansi6}${t.dim}${t.muted}`;
  if (colorMemo?.key === key) return colorMemo.c;
  const dark = luminance(bg) < 0.35, fixed = dark ? DARK : LIGHT, c = { plain: t.foreground ?? (dark ? "#d4d4d4" : "#1f2328") };
  for (const [name, from] of Object.entries(FROM_THEME)) {
    const v = t[from];
    c[name] = v && /^#[0-9a-f]{6}/i.test(v) && contrast(v, bg) >= (name === "comment" ? 2.5 : 3) ? v.slice(0, 7) : fixed[name];
  }
  colorMemo = { key, c };
  return c;
}
/** Colors for EditorState.new({syntax}) so the full-file view matches the diff. */
export const editorSyntax = (t) => { const { plain, ...rest } = colors(t); return rest; };
function luminance(hex) {
  if (!/^#[0-9a-f]{6}/i.test(hex ?? "")) return 0;
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
export function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }

/** Spans -> runs covering the whole text: [{start, end, text, color, span?}]. Neighbours with the same color merge;
 *  a `ref` span stays its own run (it gets its own element for hover and click). */
export function runs(text, spans, c) {
  const out = [];
  const add = (start, end, color, span) => {
    if (end <= start) return;
    const last = out[out.length - 1];
    if (!span && last && !last.span && last.color === color) { last.end = end; last.text = text.slice(last.start, end); return; }
    out.push({ start, end, text: text.slice(start, end), color, span });
  };
  let at = 0;
  for (const s of spans) {
    if (s.start < at) continue;
    add(at, s.start, c.plain);
    add(s.start, s.end, c[s.kind] ?? c.plain, s.ref ? s : null);
    at = s.end;
  }
  add(at, text.length, c.plain);
  return out;
}

/** gpui children for one line. `div` is gpui-kit's (passed in so this module stays pure); `decorate(el, run, i)` may
 *  wrap or extend ref runs (id, hover, click, HoverCard). */
export function renderLine(div, text, spans, c, decorate = null) {
  if (!spans.length) return [div().flex_none().whitespace_nowrap().text_color(c.plain).child(text)];
  return runs(text, spans, c).map((r, i) => {
    const el = div().flex_none().whitespace_nowrap().text_color(r.color).child(r.text);
    return r.span && decorate ? decorate(el, r, i) : el;
  });
}

/** The clickable span at a UTF-16 offset (or null). For lists that can't hold per-token handlers (gpui virtual lists):
 *  offset = floor((press.x - codeLeft) / charWidth) in a monospaced row. */
export const refAt = (spans, offset) => spans.find((s) => s.ref && s.start <= offset && offset < s.end) ?? null;
