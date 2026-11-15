# Changelog

## Unreleased

### Features

- review: tick findings in the Findings tab and hand the ticked ones to one fix agent with "Fix selected (n)…"

## 0.11.1 (2026-11-15)

### Fixes

- pr-review: IntelliJ from the Snap store is found by its launcher's own name

### Other

- chore: merge feat/herdr-0116 (snap names for IntelliJ)

## 0.11.0 (2026-11-15)

### Features

- review: a Copy as Markdown button in the head of every page it can copy
- review: a finding at a state machine names the move it is about
- pr-review: remove a review from In progress with Undo, show merged ones dimmed, other repos behind Show all
- review: the resilience run checks each dependency that is slow, overloaded, down, answers wrong or comes back
- pr-review: list and remove fix worktrees, back off failed PR scans, remember Markdown heights
- review: finding chips that would touch in a state diagram are one chip
- review: fewer terms on the first screen, one place for each fact, visible click targets in the diff
- review: Copy as Markdown shows a preview first and copies the whole page with its pictures and code
- security: one count of security findings, the operator's trust level, guards that say what they hold against
- pr-review: the panel shows what the review knows, says why a diff failed, and asks before Discard
- review: the Copy as Markdown preview lists findings by severity and stays inside a narrow pane
- pr-review: the list stays after a review opened from it; the chip shows the review's risk; no jerk on resume
- pr-review: a fourth source, This space: the PRs of the branches checked out in the space
- review: state diagrams route every transition on its own line and label it
- review: one sign says how severe and how sure what stands behind a page is
- security: order cards and frames so calls run straight
- pr-review: a timing picture on the Resilience page
- pr-review: a fault tree for each case of a failing dependency
- lsp-bridge: symbols of a file and references of a name
- review: Impact on the Architecture page, the changed functions and their callers
- review: infrastructure changes on the Architecture page, read from the diff
- syntax: Makefiles, YAML with workflows and Spring settings, key=value files and TOML get their own colors
- pr-review: tell the Worktrees mod which PR belongs to which branch
- pr-review: who may do what and where sensitive data goes on the Security page
- review: schema changes on the Architecture page, read from migrations and model files
- review: lay the schema picture out once per marks, a big one after the frame
- pr-review: Open in your editor, from a file's head, a definition, a card's place and the panel
- explore: Explore can be minimized, and a failed run offers Retry
- pr-review: init starts no task and no timer during herdr-app check
- pr-review: watched folders are cancelled when a repo is let go and when the copy closes
- pr-review: review and fix worktrees go to Herdr's worktrees folder, never into the clone
- pr-review: tabs are named repo first, and the review's Ask tab opens in the background
- pr-review: a file's head and its panel row drag onto a terminal as the path in the checkout
- pr-review: editor link on Impact cards, callers and Infrastructure cards
- pr-review: a legend line over the rights table

### Fixes

- pr-review: the PR panel follows the Herdr space and lists only relevant PRs
- review: Fit only narrows the map's cards and never puts it in rows
- pr-review: the PR panel draws and fetches only for new data
- security: a deny rule is a guard, one placeholder per place, operator ways by name, Codex named as Codex
- review: the Security page counts the findings behind threats, shows guards as guards and one row per crossing
- review: one blast line per deployment, the zone's name in full on the security map, a smoke tour with a guard
- security: an operator's threat covers its script's call only, a guard reads as what it denies, tool words leave the skipped list whole
- pr-review: the list of fix worktrees can open at a given spot; the folded merged row says what it leaves out
- review: a dependency's open question reads as one clause ("is slow or overloaded")
- review: a bundled finding chip stands right of its last arrow
- pr-review: a repo written to while its diff loads is checked again without waiting for a render
- pr-review: back from a review the panel shows that review's PR, not the one picked before
- pr-review: a resumed review opens on the tab and page you left, without a jump
- security: what follows from the shield follows from the effect, a threat cites only what enables it
- review: resilience follow-ups: a case scrolls to its path, marks wrap on the card, the route's own reason blocks
- test: the smoke test says when its fixtures are missing, and the bundle leaves it out
- review: every cache has a limit and goes with its PR
- pr-review: the last pick wins while something loads; review opens the branch's PR again; wrap, a line for a merged review
- syntax: shell scripts are highlighted again, also without an ending
- review: resilience shows the listed path number instead of run ids
- review: the Markdown preview counts one way and names what is left out
- review: security crossings fold the other findings and name a finding once
- review: a path and its probe say old or new once
- review: the verdict says when its security count comes from a run under older rules
- review: model runs get an allowlist of the environment
- review: Before merge counts rows and keeps a cause's later findings at its row
- review: the Codex run reads only the checkout and loads no MCP, hooks or PR config
- panel: file marks take the security sign from the same source as the review
- review: one effect said by several sources near by is one finding
- review: a probe's script and result come from the runner only, never through a link
- review: the probe of a dated path says what its script did on the base
- review: one file that cannot be colored no longer keeps the whole diff plain
- review: the push lock also holds for a remote with a push URL of its own
- review: the push lock's note shows no push URL, and its gate is tested in the layout
- review: search for the better map layout after the render
- review: lay the infrastructure picture out in one pass
- review: search for the better map layout after the render
- syntax: no scanner can hold a line for ever, and a stopped slice no longer stalls the colors
- review: lay maps out within a render's slice, search in slices after it
- pr-review: a click on a Worktrees PR mark is kept for the panel; the panel starts with Worktrees there
- review: the command loop survives a command that threw or was stopped
- review: Impact leaves infrastructure files to Infrastructure changes
- review: the infrastructure picture uses the one layout mechanism
- llm: a run that gave no answer says so in one sentence, not with the CLI's result object
- pr-review: no cx is used after its call, and a click waits for the folder's files
- pr-review: a dry run starts no editor; no editors found is not kept for a day
- pr-review: a file editor.dry-run in the Herdr home keeps every editor from starting
- pr-review: the Infrastructure title counts resources, values and notices by name
- pr-review: a PR that is not trusted opens only a tracked regular file, and no build file by any spelling
- pr-review: a changed symbol's name is matched as text, not as a pattern
- pr-review: names and values from the PR are inert in the copied Markdown
- pr-review: an infrastructure file written to break the reader costs its section, not the review
- pr-review: an untrusted PR's file is opened by its real path, after the index and the disk agree it is a regular file
- pr-review: editor links look again after none was found, a menu's pick is its own, one wording for the menu
- pr-review: a saved result replaces the file from before, and a hidden feeding copy does not count
- pr-review: the panel's editor link stands at the open file's name

### Other

- test(review): the smoke test draws the definition view, the Ask drawer, Look inside, Explore and the popups
- test(review): a script refreshes the review fixtures, and the fixtures are today's
- chore: merge feat/ux-backlog into the smoke leftovers
- test(pr-review): smoke-test the PR panel
- Merge branch 'feat/ux-backlog' into feat/ux-panel-bugs
- test(review): the smoke test opens each comment card's menu, sent threads, a note and every probe's script
- chore: merge feat/ux-leftovers-smoke
- chore: merge feat/ux-panel-bugs
- chore: merge feat/ux-backlog (panel follows the space, relevant PRs) into the render fixes
- chore: merge feat/ux-backlog into the Fit, Copy as Markdown and transition work
- chore: merge fit without wrapping and a visible Copy as Markdown
- chore: merge feat/ux-backlog into the security judge work
- chore: merge feat/ux-backlog into feat/ux-res-downstream
- chore: merge the security page after its judgement
- chore: merge feat/ux-backlog into the panel render and removal work
- Merge branch 'feat/ux-backlog' into feat/ux-panel-render
- chore: merge feat/ux-backlog into the UX leftovers
- chore: merge feat/ux-backlog into feat/ux-res-downstream
- chore: merge feat/ux-backlog (security page) into the UX leftovers
- chore: merge a panel that renders only on new data
- chore: merge feat/ux-rest
- chore: merge feat/ux-backlog into the second security judge round
- chore: merge resilience for dependencies that fail or are overloaded
- chore: merge feat/ux-backlog into the Copy as Markdown preview and whole-page text
- chore: merge feat/ux-backlog (dependencies that fail) into the whole-page Markdown
- chore: merge one security count, the operator level and guards
- docs(review): the Resilience page's Copy as Markdown help names the dependencies that fail
- chore: merge feat/ux-backlog (one security count, operator level, guards) into the whole-page Markdown
- chore: merge the Markdown preview, full pages with diagrams and code context
- chore: merge feat/ux-backlog into the third security judge round
- chore: merge feat/ux-backlog into the panel work (minimize bug, resume, UX findings)
- chore: merge feat/ux-backlog into the preview by severity
- chore: merge fix/bundle-smoke
- chore: merge feat/ux-sec-judge3
- chore: merge feat/ux-panel-render
- chore: merge feat/ux-backlog (panel render) into the preview by severity
- chore: merge the Markdown preview by severity and dependencies in the export
- Merge branch 'feat/ux-backlog' into feat/ux-panel-rest
- chore: merge feat/ux-backlog into feat/ux-res-rest
- chore: merge the panel's rest: wrap, races while loading, setup, review without a pick
- chore: merge the list stays after a deliberate back, risk on the minimized chip
- chore: merge feat/ux-backlog into feat/ux-res-rest
- chore: merge feat/ux-backlog into feat/ux-res-rest
- chore: merge resilience follow-ups and cache limits
- refactor(review): text sizes are named steps instead of fifteen numbers
- chore: merge the type ladder
- refactor(review): a state label's width holds the room for its chip
- chore: merge feat/ux-backlog into feat/ux-state-diagram
- chore: merge feat/ux-backlog into feat/ux-shell-icons
- Merge branch 'feat/ux-shell-icons' into feat/ux-backlog
- chore: merge feat/ux-backlog into feat/ux-map-layout
- Merge branch 'feat/ux-map-layout' into feat/ux-backlog
- Merge branch 'feat/ux-backlog' into feat/pic-time
- test(perf): count what a frame costs, on PR #2 and a synthetic big review
- Merge branch 'feat/ux-backlog' into feat/pic-impact
- perf(findings): a frame no longer looks up every finding's rows on each ask
- Merge branch 'feat/ux-backlog' into feat/pic-infra
- docs(setup): what the Codex run, the push lock and probes need installed, and what happens without it
- perf(review): no JSON text of the map per frame, the diff is read once for the resilience start
- docs(setup): language servers also turn on Impact, with their install commands
- perf(arch): a map of more than 20 cards is laid out after the frame, not in it
- chore: merge feat/ux-backlog into feat/ux-shell-icons
- chore: merge the acceptance corrections (UX and engineer)
- perf(diff): listing the diff asks what hangs under a line only where something does
- perf(security): the Security page computes its crossings once, not twice per frame
- Merge branch 'feat/ux-accept-sec' into feat/ux-backlog
- Merge branch 'feat/pic-time' into feat/ux-backlog
- Merge branch 'feat/pic-impact' into feat/ux-backlog
- Merge branch 'feat/ux-backlog' into feat/pic-infra
- Merge branch 'feat/ux-shell-icons' into feat/ux-backlog
- perf(review): a running fix's cost is not polled behind another window
- Merge branch 'feat/ux-map-layout' into feat/ux-backlog
- Merge branch 'fix/highlight-queue' into feat/ux-backlog
- perf(open): the review no longer waits for git before it shows the cached diff
- perf(open): where a resilience run would start is counted a second after the review opened
- chore: merge feat/ux-backlog into feat/perf
- chore: merge feat/ux-backlog into feat/perf
- perf(panel): the panel's diff is a virtual list, so a frame no longer grows with the file
- chore: merge feat/ux-backlog into perf/panel-diff-list
- Merge branch 'feat/ux-backlog' into feat/pic-schema
- Merge branch 'feat/ux-backlog' into feat/pic-infra
- perf(review): a view whose frames Herdr stopped draws less; the Walkthrough has its own line limit
- chore: merge feat/ux-backlog into feat/pic-sec
- chore: merge feat/ux-backlog into feat/perf
- Merge branch 'feat/pic-sec' into feat/ux-backlog
- chore: merge feat/ux-backlog into feat/perf
- chore: merge feat/ux-backlog into fix/map-layout-budget
- perf(panel): the panel builds only the body it shows
- chore: merge feat/ux-backlog into perf/panel-diff-list
- chore: merge feat/ux-backlog into perf/panel-diff-list
- perf(review): the layout search prices an order without re-sorting every column
- Merge branch 'feat/pic-infra' into feat/ux-backlog
- chore: merge feat/ux-backlog into feat/pic-schema
- chore: merge feat/ux-backlog into fix/map-layout-budget
- chore: merge feat/ux-backlog into fix/map-layout-budget
- perf(walkthrough): 3 000 lines, the open layer first; a view draws less after three stopped frames, for five minutes
- perf(review): no log reads for a fix whose agent ended, no frame for a poll that found nothing new
- perf(shared): shared state is written for another value only; a visit alone does not rewrite the register
- test(smoke): a review keeps its analysis through the whole tour
- chore: merge feat/ux-backlog into fix/map-layout-budget
- perf(panel): the list of PRs is built only while it shows
- test(infra): name the layout queue that is there
- chore: merge feat/ux-backlog into feat/perf2
- chore: merge feat/ux-backlog into fix/explore-minimize-errors
- chore: merge feat/ux-backlog into Open in your editor
- chore: merge feat/ux-backlog (the Explore chip) into Open in your editor
- perf(review): coloring a diff asks for two frames, not one per slice
- refactor(pr-review): the editor menu as plain data, for the other mods that draw it themselves
- Merge branch 'perf/highlight-frames' into feat/ux-backlog
- Merge branch 'feat/open-in-editor' into feat/ux-backlog
- perf(live): the panel and the review are no longer drawn for every agent's status change
- chore: merge feat/ux-backlog into feat/perf2
- Merge branch 'feat/ux-backlog' into feat/open-in-editor
- chore: merge feat/ux-backlog into feat/pic-schema
- chore: merge feat/pic-schema into feat/ux-backlog
- refactor(pr-review): one title line for Impact, Infrastructure changes and Schema changes
- test(pr-review): the review fixtures name a path by the number the page shows
- docs(pr-review): the new pictures, the Security page's name and the editor requirements on Linux
- chore: merge feat/herdr-0116 into feat/ux-backlog
- docs(pr-review): copy as markdown, the short editor link and large infrastructure files

## 0.10.0 (2026-11-15)

### Features

- review: pick, reviews, add and fix-finding commands, the same as their clicks
- panel: one row per PR with its risk signal, merged PRs folded
- panel: Review is the header's filled button, pending comments open Finish your review
- review: mark the PR a stacked PR sits on in the related context
- review: link requirements, findings and the picture; a fixed severity scale
- review: one finding per defect, a fix sent stays unresolved, one count
- review: keep the token breakdown of a run, report requirements no finding names
- review: pass the newer analysis fields through to the views
- review: the left column shows what is unresolved, not run data
- review: the task check as one list under a verdict line on the Overview
- review: findings and comments are written as markdown, titles stay plain
- review: name the rules in the bar, copy the review state, offer to save again
- review: the file tree names findings in words and has a 16 px tick
- review: show a layer's check questions and pictures once, over its code
- review: verify a sent fix on its own branch, before it is in the PR
- review: fold finding cards in the diff to one line and show what a finding claims
- review: the architecture map shows where the flow breaks and wraps into a second row
- review: the Security page is a list with what each run checked and who may reach what
- review: trust zones, crossing edges and where a security finding is reachable from
- review: previews say what an agent gets and may do, Finish knows the findings
- review: render Markdown in comment and finding cards
- review: ask for a call's text on its line in a layer's flow picture
- review: a finding becomes a structured comment, written like the reviewer's own
- review: pair a diff's old and new lines for a side-by-side view
- review: a fix stays on its branch until the reviewer applies it, and Submit waits for a verdict while high findings are open
- review: pass a finding's reachability through findingFacts
- review: a finding's steps into the PR, how the count comes about, owner and effort
- review: the security reviewer draws the security view and a threat model
- review: decide from the diff alone whether the security review starts by itself
- review: wrap long diff lines instead of cutting them off
- review: copy a page as Markdown, and the context to check findings
- review: effort per finding and depends_on per layer
- review: move the PR's pages into the Analysis tab, above its layers
- review: draw a diff's old and new lines side by side, cards under them over the whole width
- review: code is read and judged by at least Sonnet, Haiku only for text
- review: click, select, comment and go to definition on either half of the side-by-side diff
- review: Security page with the map in a security view, trust zones as frames, attack surface and a grid behind the pictures
- review: switch the diff between side by side and unified, side by side by default where it fits
- review: keep new and deleted files in one full-width column side by side
- review: show the security run's view and start it by itself when the diff gives a reason
- review: keep long diff lines on one line and scroll them sideways; wrap is a switch
- review: a verify agent's task, its answer file and its result on the finding
- review: Verify with an agent at an open finding, a security finding and for all security findings
- panel: at most three marks per PR row, security first, no Deep review beside Low effort
- review: a note in a file the public reaches is a finding, whatever its category
- review: count the verdict by what decides a merge, and the parts the Overview reads
- review: the Overview in two columns, the decision left and the understanding right
- review: pr-review.fstep:<id>:<step> opens a step's details, as its click does
- review: how the findings count comes about, in one muted line under it
- review: short names, what changed, files read, introduced_here and the way from outside
- review: What each run checked opens a row to its whole text and the findings behind a Finding, and Clean names the files read
- review: count "Needs your attention" by decision and take in every security finding
- review: show the stack beside the PR title, a click opens the other PR
- review: an open finding in the Findings tab shows its facts as its card in the diff does
- review: what changed from the analysis, findings already there before the PR, no second red
- review: show the layers a layer depends on in its head, a click opens one
- review: carry "⛨ n" on the Analysis tab while security findings are unresolved
- review: pictures open their place again, and a state diagram over the code folds to one line unless a finding sits at a transition
- review: a folded security finding says how sure it is (derived, assumed, confirmed)
- review: mark a layer that opens a way in or grants a right, finding or not
- review: say when a layer's file has more lines outside the layer, a click shows the whole file
- review: a finding's card in the diff shows what its other sources say
- review: graph paper behind the sequence picture; a state picture takes its width from stateLayout
- review: a way in whose check an open finding can pass reads Auth, can fail open
- review: What each run checked marks contradictions, and Clean comes with the files read
- review: the security run names the gate at each crossing, who changes what, and every crossing it did not assess
- review: show the analysis' head and age at the top of the Analysis tab
- review: the Overview as the personas agreed: an action, Before merge, and the rest folded
- review: recommendModel and a run offer with the recommended model, a class up or down and its price, on the Security page
- review: What each run checked says what a reviewer run was allowed to do
- review: what_changed entries of one thought in twelve words, a requirement's why in twenty
- review: the Security page is a boundary map: a sentence from the data, the trust boundary crossings with their checks and results, and a picture by trust zone from three crossings on
- review: the crossings read the security run's gates and effective zones, and fold the crossings not assessed into one line
- review: the security run's own prompt checks what /security-review checked, plus rights and retries
- review: boundary map data that agrees with itself: runs_in, in-process calls, principals, paths, reach conflicts
- review: the boundary table takes in the attack surface and the rights, shows the way to the asset and where the data disagree; the map has an Internet card at the way in
- review: the boundary page reads the run's bypasses, reach_conflict and operator ways, and draws the way from the door with the gate in front of its target
- review: a resilience run: how a failure spreads through the PR, as facts at their lines
- review: resilience ladders, budgets and blockers in pr.js, and where the run would start
- review: a Resilience page: where the run starts, the paths a failure spreads along with their picture, action and probe, and its blockers on the Overview
- review: the Resilience page reads a path in either shape, the view's own or withResilience's
- review: the resilience run weighs each part the PR adds against its cost
- review: the Resilience page runs on withResilience and resilienceStart, lights the cards of a path's places, and prices a first run from its measured typical cost
- review: probes that run a PR's code in a sandbox to show a suspected failure
- review: Resilience shows complexity against use, reads R-D's names and cost, and takes probes from probesNow with their confirm step
- review: resilience ladders for paths named by their lines, and the map's marks
- review: map marks for a call without a timeout and from what a path breaks
- review: a card with a mark of the chosen resilience path is lit with it
- review: a taken-over principal as the threat of a right, runs_in in several processes, effective zones passed on
- review: a long line from a column's top card may run over the picture when that saves a crossing
- pr-review: bind resilience deps to the map, add signal, request paths and writers
- review: resilience page in words, readable map, prices, verdict and watch list (wave R2 V4-V8)
- pr-review: block a dishonest route, one blocker per redelivery, retry under redelivery unjustified
- review: a queue's mark at the queue, a call's marks and unlimited redelivery on the call (wave R2 V3)
- review: the probe's base in the runner's words, and its sandbox kept for the evidence (wave R2 V6)
- review: the resilience export says what the page says (wave R2)
- pr-review: a raising failure is at least platform_only, parts judged by purpose
- review: a band of the wrapped map leaves out the strip over the picture it does not need
- review: the resilience page reads the R2 data (reach, unseen and watch, same cause, unclear blockers dated by their probe, state rules, races not possible today)
- review: a redelivered batch over its timeout shows its budget under the ladder (wave R2 V1)
- review: whether a part works today under it, and the overruled signal in the seen tooltip (R2 D6, D2)
- review: resilience verdict short with its count, the map at the path's start; a finding marks only its transition; dimmed card texts at 4.5:1 (wave C2 V2, V4, V5)
- review: a reproduced probe confirms its path's findings, with the platform modeled when it was (wave C2 V3)
- pr-review: merge findings by cause, a reach row, blocks once wired, no secrets in model runs
- review: no cut text: a finding's mark in two lines on the map, the crossings as a list with Who, Check, Holds only if and Result in view (wave C2 V1)
- review: a path that cannot happen today blocks once wired, after the blockers and said apart (wave C2 D3 view)
- review: say what a fix agent costs: an estimate in the preview, the cost so far while it runs
- review: persona backlog, boundary map, resilience page with probes, fewer fetches

### Fixes

- review: read the findings of a forked /code-review instead of counting 0
- review: "open" names one thing
- review: a jump to a layer or a file lands at the top
- review: send the structured answer once; seat the state diagram in its layer
- review: a fix branch starts at the PR head, and a fix agent cannot push
- review: the scope line no longer reads "3 skimmed (skimmed)"
- review: scripts write no bytecode into the mod's folder
- review: say the composer's hint once and keep "Post now" away from the main button
- review: bound the gutter marks of a finding by the lines that are shown
- review: the page's parts as the architecture package names them; ask: stays the Ask drawer's
- review: the fix-several preview starts with the list only, Discard asks alone
- review: a finding's buttons come in one order in the list and in the diff
- review: bring back the Overview page, the since banner and openRelated
- review: state diagram lines run through a skipped row, and the picture is as wide as its lines
- review: findings up to three lines apart with the same claim are one finding
- review: the same line with a different claim stays two findings
- review: anchor a side-by-side selection on its own half's lines
- review: suggestions join their line again, reviewer lines move to code first
- review: start the security run by itself only for a trusted PR; match a zone's name without spaces
- review: start the security review by itself only on a trusted PR, and confine every reviewer
- review: cards on the map are opaque, so the grid does not show through them
- review: Architecture impact draws its map once
- review: show a bot's HTML comment as its text, an image as its alt text
- review: no "0 of 0 files viewed" under a layer without files
- review: the Overview names every precondition of a finding
- review: draw the architecture map once, in one row unless Wrap is on
- review: the map is one row by default, Wrap is remembered, and a wrapped map never cuts a frame
- review: deny git options by their shortest prefix, and run the analysis under the reviewers' rules
- review: the security picture follows the same Wrap setting as the architecture map
- review: a finding outside the diff opens its file read-only, a failed jump's note goes with the next
- review: keep the left column whole at any width
- review: the Security picture shows only what matters for security, and none without security data
- review: Architecture impact folds the list of calls, and More views draws a sequence as a sequence diagram
- review: order "By focus" by the grade each layer row shows
- review: a PR stacked on this one is no merge blocker either; related.py lists it as stacked_above
- review: a finding that breaks a requirement of this PR is the PR's, also in old lines
- review: model runs call git only through safegit.py, which keeps every path inside the checkout
- review: the Overview one line a row, what is met folded, what needs attention first
- review: one name for the green button: "Finish your review"
- review: a finding's state shows only when it is not unresolved
- review: compare a finding's line range with the diff instead of building it
- review: the Overview's Security group carries the ⛨ sign like the verdict and the bar
- review: a jump to a file or a page closes a file opened read-only
- review: say a layer's sentence once, in its head over the code
- review: jumpTo and goDef share one path rule, and a jump from goDef never calls it again
- review: a jump that goDef starts never calls goDef again, so the two cannot loop
- review: ⛨ marks a finding only when its effect is access or data, not who found it
- review: let the slash commands' fixed git commands run, and keep plain git off paths outside
- review: show what is going on at the top of the Analysis tab, not under the page
- review: the Overview names the PRs stacked on this one
- review: turn a slash command's review into findings also when it is the main answer's text
- review: rebuild the review when the PR gets a new head
- review: the architecture map is framed by system again; a card's trust zone is a dot, a call over a boundary names both zones
- review: git only through an allowlist in safegit.py, plain git denied for every run
- review: a finding's mark on the map names the finding, and a click opens it
- panel: mark a PR row with ⛨ by isSecurity, as the review does
- review: a note about an action in the text color; an error in red stays until closed
- review: safegit splits options the way git does, or refuses
- review: built-in read-only commands of a run read only inside the checkout
- review: a reviewer's allowed tools name a helper by its file name, not its path
- review: a flaw is the PR's when the PR opens the way to it, and one in unchanged code is not
- pr-review: prune analysis run folders and old findings and replies
- review: a crossing's result comes from threats only, a way in starts with who arrives, a principal maps to its frame, and a call in one process is no crossing
- review: an in-process call bypasses a boundary only into code with its own way in
- review: fix and verify agents start without the context's MCP servers
- review: runs_in may name a frame, and a caller the analysis draws itself is no second way in
- review: fix and verify agents start without the context's MCP servers
- review: read a checkout's files only as regular files inside it, and stop a runs_in cycle
- review: the Overview's context line reads the PR context from the review
- review: the Overview hands the theme to the run offer
- review: system and zone frames are opaque, the grid stays between them
- review: the map opens in Fit when it is wider than the view, and a way in stays next to its caller from outside
- review: show GitHub comments as GitHub does and size them to their text
- review: a line of the boundary picture says what goes over it and its check; the tooltip explains instead of repeating the label
- review: the sequence diagram uses the room it has, keeps every call and its text inside, lifelines stand out
- review: one finding per defect at one named resource, also a few lines apart
- review: a click in a picture ends the drag its press began, so the picture no longer jumps back
- review: a call to itself on the last column keeps its text left of the lifeline, clear of its loop
- review: the run offer wraps inside its column
- review: every group of pictures takes the page's width, sequence lifelines in full contrast
- review: long lines take part in card and lane order, so avoidable crossings with next-column calls go
- review: resilience blockers for visible effects only, one cause once, and the base rule for what was there before
- review: a bounded poison message and a request that just times out block nothing
- review: probes on Linux run under bwrap, or count as unfenced
- review: the question before a probe says what unfenced code can do
- review: a probe without a sandbox says so
- review: the Linux probe sandbox binds no / and no socket, the interpreter never shows the home
- pr-review: stop the LSP bridge when Herdr quits
- review: boundary crossings: right and call as one row, defects assess nothing, zones passed on in one process, ways through every gate; Fit wraps whole frames
- review: two long lines from one column nest on their channels where their order allows
- review: runs_in as a list takes the most exposed zone; effective zones come from the data with the crossing they hang on
- review: lines running on top of each other are counted, and lanes avoid them before crossings
- review: the runner reads a probe's strength from its source and says what the base run means
- pr-review: reach a card without a place by its file's name
- pr-review: number the picture's edges, count only calls a path takes
- pr-review: mark resilience runs that saw edge ids, flag older ones for a re-run
- review: a probe id outside 1 to 40 letters, digits, - and _ is refused everywhere
- review: a resilience path's way names the cards of its calls
- review: the resilience map keeps a line in every card a path marks; shorter probe evidence; names of checks capitalised
- review: a path's mark in a card of the resilience map has its own line, apart from a finding's chip
- review: the macOS probe sandbox reads from an allowlist
- review: one ranking before the merge: the box over the layers is the Overview's list
- review: no MCP for the Ask and Send review tabs, a push lock in git itself, and a trust question that names what it turns on
- review: offer a finished run as Re-run with its last run, not as a first Run
- review: state chips without a frame, a real Viewed box, and the last word leftovers
- review: a file's heading in the Comments tab shows that file in the diff
- review: count "Before merge" by cause: a later finding of one cause stands at its first

### Other

- docs(recipe): the panel's header, list rows and pending comments as they are now
- chore: merge the panel package
- chore: merge the analysis package
- chore: merge the overview package
- chore: merge the left column package
- chore: merge the prompt and bytecode changes
- chore(review): keep stack.js's header comment as the architecture package has it
- Merge branch 'feat/ux-backlog' into feat/ux-overview
- chore: merge the diff package
- chore: merge the fix package
- chore: merge the findings tab package
- chore: merge copy as Markdown
- chore: merge the analysis tab in the left column
- chore: merge security on demand and the threat model
- chore: merge the architecture map and security page
- chore: merge no Haiku for code work
- chore: merge the security view wiring
- chore: merge the side-by-side diff
- Merge branch 'feat/ux-backlog' into feat/ux-prompts
- Merge branch 'feat/ux-backlog' into feat/ux-prompts
- chore: merge near-duplicate findings
- test(review): the security view test merges two sources that make the same claim
- chore: merge the trusted-only security start and tighter reviewer rights
- chore: merge the regrouped overview
- chore: merge verify with an agent
- chore: merge the analysis' new fields
- perf(review): remember where a reviewer's finding anchors, so drawing a view does not rescan every file
- chore: merge the overview follow-up and the new analysis fields
- chore: merge the overview without the wall of text
- chore: merge the PR list, stack and diff round 4
- Merge branch 'feat/ux-backlog' into feat/ux-overview4
- chore: merge the security sign on the overview group
- chore: merge the findings tab round 4
- Merge branch 'feat/ux-backlog' into feat/ux-overview4
- chore: merge the left column round 4
- chore: merge the overview after the personas' proposal
- perf(pr-review): ask for the PR list only while the panel can be seen
- chore: merge the jump guard and the security mark rule
- chore: merge the map and security page round 4
- perf(review): check the head and GitHub comments every 5 minutes while the window is in front
- chore: merge feat/ux-backlog
- chore: merge the left column follow-ups
- chore: merge the overview follow-ups
- chore: merge safegit, the security-run fields and the analysis round 4
- perf(review): reuse the PR checkout when it is already at the head
- chore: merge the security mark in the PR list
- chore: merge the safegit allowlist and shorter what_changed
- chore: merge the footer notes rule
- chore: merge the safegit option parser fix
- chore: merge feat/ux-backlog
- chore: merge the read barrier outside the checkout
- chore: merge the system map and the security boundary page
- chore: merge the sharper security prompt
- test(review): the tokenizer timing check takes the best of three runs
- Merge branch 'feat/ux-backlog' into feat/ux-fetch4
- chore: merge impact and introduced_here rules for the security run
- chore: merge the fetch and refresh audit with cache cleanup
- Merge branch 'feat/ux-backlog' into feat/ux-data5
- chore: merge feat/ux-backlog
- Merge branch 'feat/ux-backlog' into feat/ux-data5
- chore: merge feat/ux-backlog
- chore: merge the boundary map data (wave 5)
- chore: merge feat/ux-backlog
- chore: merge the boundary map fixes (wave 5)
- chore: merge feat/ux-backlog
- chore: merge the boundary map on the wave 5 data
- chore: merge feat/ux-backlog
- test(review): a render smoke test of every tab, page, layer, finding and popover on the fixtures
- chore: merge feat/ux-backlog into the smoke test
- chore: merge the boundary map check on wave 5 data and the map fit
- chore: merge feat/ux-backlog
- chore: merge GitHub markdown in comments
- test(review): the smoke test writes a comment at a line; the stand-in inputs keep their value
- chore: merge feat/ux-backlog into the smoke test
- chore: merge feat/ux-arch5b
- chore: merge feat/ux-data5b
- test(review): the smoke test shows GitHub's threads in Markdown, resolved, outdated and from a bot
- chore: merge feat/ux-backlog into the smoke test
- chore: merge feat/ux-smoke
- chore: merge feat/ux-diag5
- chore: merge full-width views and lifelines
- chore: merge fewer edge crossings on the map
- chore: merge feat/ux-backlog
- Merge branch 'feat/ux-backlog' into feat/ux-res-data
- chore: merge the resilience run and its data
- chore: merge feat/ux-backlog
- Merge branch 'feat/ux-backlog' into feat/ux-res-data
- chore: merge complexity against benefit in the resilience run
- chore: merge feat/ux-backlog
- chore: merge resilience probes in a sandbox
- chore: merge feat/ux-backlog
- test(review): the probe redaction test builds its addresses, so the leak scan stays clean
- chore: merge the resilience page
- Merge branch 'feat/ux-backlog' into feat/ux-res-data2
- chore: merge the Linux probe sandbox
- Merge branch 'feat/ux-backlog' into feat/ux-res-data2
- chore: merge fewer resilience blockers, ladders and marks
- chore: merge feat/ux-res-probe2
- chore: merge feat/ux-res-data2
- wip(review): resilience marks from marksOf on the cards of the chosen path
- wip(review): a resilience mark at a file finds the card that names that file
- chore: merge feat/ux-backlog
- test(review): a neutral path for the folder-above check
- chore: merge feat/ux-res-probe3
- chore: merge feat/ux-res-view2
- wip(review): boundary crossings fold a right into its call, skip defects, pass zones on and walk every gate
- chore: merge the LSP bridge that ends with Herdr
- chore: merge feat/ux-backlog
- chore: merge nested channels below the map
- chore: merge feat/ux-data5c
- chore: merge feat/ux-backlog
- chore: merge the last boundary map corrections (wave 5c)
- chore: merge runs_in as a list on the boundary map
- wip(review): probe agent writes only the script, the review runs probe.py
- chore: merge a channel above the map and no overlapping lines
- wip(review): a probe's strength from its syntax tree, not from a docstring
- chore: merge the fixed probe flow
- Merge branch 'feat/ux-backlog' into feat/ux-res-data3
- test(review): smoke tour of the resilience page with signals, blind spots and a probe not run
- chore: merge resilience data bound to the map
- Merge branch 'feat/ux-backlog' into feat/ux-res-view3
- chore: merge the edge id note and fresh security fixture
- Merge branch 'feat/ux-backlog' into feat/ux-res-view3
- Merge branch 'feat/ux-backlog' into feat/ux-sec-edges
- chore: merge the probe id rule
- chore: merge signal from raises and additions measured by purpose
- Merge branch 'feat/ux-backlog' into feat/ux-res-view3
- chore: merge the resilience page after the role check (R2)
- chore: merge works today and the run's own signal word
- chore: merge a mark on its own line
- chore: merge no MCP for PR text tabs, honest trust and push
- chore: merge the macOS probe sandbox as an allowlist
- chore: merge the sandbox allowlist, no MCP for PR text tabs and the push lock into the overview fixes
- Merge branch 'feat/ux-backlog' into feat/ux-c2-view
- chore: merge one ranking on the Overview and re-run offers
- chore: merge no cut text, security as a list, probes confirm
- Merge branch 'feat/ux-backlog' into feat/ux-c2-view
- chore: merge paths that block once wired
- Merge branch 'feat/ux-backlog' into feat/ux-c2-data
- chore: merge the cause-counting data round (C2 D) into the overview fixes
- chore: merge findings by cause, reach row, blocks once wired, no secrets in runs
- chore: merge the fix agent's cost estimate and running cost

## 0.9.0 (2026-11-13)

### Features

- review: model pickers list the models the claude and codex CLIs offer
- review: the model picker shows each model's token price and prices its estimate by it
- arch: drill from a card into the layer analysis of its code
- arch: the card's overview shows the layer analysis with each layer's highlight, riskiest first
- review: the analysis files architecture-review findings inside its layers
- review: minimize a review to one entry at the top, open or close it from there
- review: card, order and minimize commands, for keys and scripted demos
- review: resolved threads, a bot filter by latest reviewed commit, and stale marks on local comments
- review: diagrams and inside commands, the same model calls as their buttons

### Fixes

- arch: a tidier card panel with Overview and Layer analysis tabs
- review: name a layer's level as reading depth (Read closely, Read, Glance, Skim), not as risk
- review: the model picker lists the current models only (the CLI's aliases)
- review: an analysis finding's id is what it is about, so its status survives a push
- review: the minimized review is a small chip, its title in the tooltip
- review: Go to's Review PR and Resume review open the review while the PR panel is hidden
- review: syntax colours in slices outside render, so a big file no longer interrupts the panel

## 0.8.1 (2026-11-12)

### Features

- review: start fix sub-agents in auto mode

### Fixes

- review: show a background fix agent's real status instead of ended
- review: auto mode for fix sub-agents only on trusted PRs
- review: untrusted PRs start fix sub-agents in manual mode without the checkout's settings

## 0.8.0 (2026-11-12)

### Features

- arch: stack a picture wider than the view in bands, and set a cramped edge label on the roomier side
- arch: a Wrap switch beside Fit, bands or one row to scroll
- arch: wrap by itself only while Ask is open
- arch: a click on a card shows what it does and what the PR changes in it
- review: run Explain for several cards at once, each card keeps its own result
- arch: the card panel names the card's file and its links to other cards
- review: architecture cards carry their name in the code, details name the file
- arch: card details and Explain answers in markdown, bullets with bold changes and code names

### Fixes

- review: keep big PRs inside Herdr's ~50 ms script slice
- arch: give each self-loop its own row beside the card, clear of its neighbours
- arch: wrap only when switched on, never by itself

## 0.7.0 (2026-11-11)

### Features

- arch: bigger jump chips with the call's number as a badge and a clearer tooltip
- review: fold and open files by themselves while scrolling

### Fixes

- arch: jump chips as wide as their text

## 0.6.0 (2026-11-11)

### Features

- review: fold lock files and changes over 400 lines when a review opens
- review: files past the list's room fold by themselves; opening one folds those opened longest ago

### Fixes

- panel: review PRs over 300 files via the pull request files API
- review: keep row arrays across renders so a big diff is never hashed in render
- review: fold files past the virtual list's 10000-item limit instead of crashing

### Other

- perf(panel): cache big PR diffs in parts

## 0.5.0 (2026-11-11)

### Features

- review: hand finished fixes to the PR's agent

### Fixes

- review: one scroll axis per gesture in the flow, state and blast pictures

## 0.4.0 (2026-11-11)

### Features

- ui: explain controls with hover texts, rename the Mine chip to Yours

### Fixes

- review: give the two header rows more room

## 0.3.0 (2026-11-11)

### Features

- review: resizable layers column, wider by default
- review: ask about the architecture
- panel: split the side panel into picking and a chosen PR
- review: draw flow pictures like Architecture impact
- review: keep sent comments as threads with agent replies
- review: fix comments with a sub-agent in its own worktree
- panel: show replies and fixed threads in the in-progress line
- review: Ask in a drawer, pinned answers as private notes
- review: compact comment cards, a floating selection bar, a two-row header
- review: steady sideways scrolling and a Fit view for wide pictures
- review: a Comments tab and a Show switch for comment kinds
- review: let the analysis choose its scope for big PRs
- review: drill down into a card or a layer
- review: explore a topic in existing code without a PR

### Fixes

- review: size the keyboard shortcuts popup to its content
- review: open the comment box from a selection, keep letters in inputs
- review: one channel per target, badges in reading order, Ask on demand
- llm: retry once when the claude binary is briefly missing
- review: say who posts where, post no empty body, make the deep review easy to find
- review: explore folders start in Restricted Mode

### Other

- docs: describe Ask, drill-down, Explore, comment threads and Fix

## 0.2.1 (2026-11-10)

### Fixes

- review: bound the diagram layout search so big pictures render in time

## 0.2.0 (2026-11-10)

### Features

- review: readable architecture impact for many edges
- review: tell spec from implemented, refresh diagrams on demand

### Other

- docs: refresh the architecture impact screenshot and describe the new pictures

## 0.1.1 (2026-11-10)

### Fixes

- Review PR from Go to works while the review layout is open

### Other

- docs: name it as part of Corgi
- docs: use the GitHub link for agent installs
- docs: highlight the changeset, architecture and sample values

## 0.1.0 — initial release

- First tagged release.
