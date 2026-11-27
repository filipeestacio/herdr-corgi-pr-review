// Starting a new agent tab that gets PR text, once for the three paths that start one ("Main agent" fix, "Ask an
// agent…", "Send review"). pr.js tabTaskDelivery decides how the text arrives: Claude Code takes it as the last
// argument of its command, a harness `agent` launcher starts bare and gets it with `hc send` when its agent reports
// ready. A harness tab's text is recorded first (pr-data/pending-tabs.json): a wait that is superseded, or a tab that
// never reports ready, leaves the record, and any copy of the mod sends the text once its agent is ready
// (deliverPending, on init and on a 2 s tick). A record is claimed with a compare-and-swap write that removes it before
// `hc send`, so two copies that see it at the same moment send it once.
import { hc, readTextFile, writeTextFile, run, appHome } from "herdr";
import { agentReady, tabTaskDelivery, tabTerminal, PENDING_GRACE_MS, pendingAdd, pendingFileText, pendingRetry, pendingRemove, pendingState, pendingTabs,
  pendingSentNote, pendingExpiredNote, pendingFailedNote } from "./pr.js";

const POLL_MS = 500, READY_MS = 60000;
const pause = (cx, ms) => new Promise((done) => cx.timer.after(ms, done));
const doc = (text) => { try { return JSON.parse(String(text ?? "")); } catch { return null; } };
// `hc ls --json` prints {terminals: [...]}; a bare list is taken too, so a version that prints one still works.
const terminalsIn = (text) => { const d = doc(text); return Array.isArray(d) ? d : Array.isArray(d?.terminals) ? d.terminals : []; };
const getTerminal = async (address) => { const r = await hc(["get", address, "--json"]).catch(() => null); return r?.code === 0 ? doc(r.stdout) : null; };
// The tab a terminal is in, as Herdr labels the terminals it starts (herdr.tab); null when it carries no such label.
const tabId = (t) => (typeof t?.labels?.["herdr.tab"] === "string" && t.labels["herdr.tab"] ? t.labels["herdr.tab"] : null);
const pendingFile = () => `${appHome()}/pr-data/pending-tabs.json`;

// The terminal of the tab just started: `hc ls` names the tab in its `where`, and `hc get` says which space it is in
// (labels["herdr.space"]), which tab that is (labels["herdr.tab"], as `tab`), when it was created and what its agent
// reports. The newest match wins: `hc` lists terminals in creation order, another space may hold a tab of the same
// name, and an older tab of that name may still be open.
async function findTab({ space, name, since }) {
  const r = await hc(["ls", "--json"]).catch(() => null);
  const named = terminalsIn(r?.stdout).filter((x) => Boolean(name) && typeof x?.where === "string" && x.where.includes(name));
  const got = await Promise.all(named.map((x) => getTerminal(x.address)));
  const t = tabTerminal(got.filter((x) => !Number.isFinite(x?.created_ms) || x.created_ms >= since - 2000), { space, name });
  return t ? { ...t, tab: tabId(t) } : null;
}

// Waits for that terminal's agent to report ready. Resolves { address, tab } when it is ready, { address, tab,
// finished: true } when its program ended first (a plain shell is never ready either), { stopped: true } when stopped()
// says the note is superseded, and { address, tab } with no address when 60 s pass without either.
async function waitReady(cx, { space, name, since, stopped }) {
  const until = Date.now() + READY_MS;
  let found = null;
  for (;;) {
    if (stopped()) return { stopped: true };
    const t = found ? await getTerminal(found.address) : await findTab({ space, name, since });
    if (t) {
      found = t;
      if (agentReady(t)) return { address: t.address, tab: tabId(t) };
      if (t.state === "finished") return { address: t.address, tab: tabId(t), finished: true };
    }
    if (Date.now() >= until) return { address: found?.address ?? null, tab: tabId(found) };
    await pause(cx, POLL_MS);
  }
}

// The document as it is now; a missing file reads as empty.
const readPending = async () => pendingTabs(await readTextFile(pendingFile()).catch(() => null));
// Writes only over the text it was read from: Herdr refuses a write when another copy changed the file meanwhile, so
// of two copies that remove the same record exactly one write lands.
const writePending = (tabs, before) => writeTextFile(pendingFile(), pendingFileText(tabs), before);

// Records a harness tab's text before the wait starts, so a reload or a superseded note cannot lose it. False when
// three writes lost to other copies: the caller sends without a record, as before.
async function recordPending(rec) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readTextFile(pendingFile()).catch(() => null), next = pendingAdd(pendingTabs(before), rec);
    if (!next.some((r) => r.id === rec.id)) return false; // nothing worth recording (no text)
    try { await writePending(next, before); return true; } catch { /* another copy wrote: read again */ }
  }
  return false;
}

// Takes a record out of the document: "taken" for the copy whose write landed (that copy, and no other, sends), "gone"
// when it is no longer there (another copy took it), "busy" when the file kept changing under three writes.
async function claimPending(id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readTextFile(pendingFile()).catch(() => null), tabs = pendingTabs(before);
    if (!tabs.some((r) => r.id === id)) return "gone";
    try { await writePending(pendingRemove(tabs, id), before); return "taken"; } catch { /* read again */ }
  }
  return "busy";
}

// `hc send` failed after the claim: the record goes back with one more try, or not at all after three. False when it
// was dropped (or could not be written back).
async function restorePending(rec) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await readTextFile(pendingFile()).catch(() => null), next = pendingRetry(pendingTabs(before), rec);
    if (!next) return false;
    try { await writePending(next, before); return true; } catch { /* read again */ }
  }
  return false;
}

// Starts the tab and gets the text there through the decision tabTaskDelivery makes. Resolves { delivery, name, sent,
// stopped, terminal, tab }: sent is true when the argv held the text or `hc send` took it, stopped is true when the note
// was superseded while waiting (the caller then keeps whatever note replaced it). sent false with stopped false: the tab
// is up and the text waits in pr-data/pending-tabs.json for any copy to send. A send another copy claimed counts as
// sent: the text goes out once. terminal is the tab's terminal when the text was sent to it, else null (Claude Code
// takes the text as its argument, so no terminal is looked up), and tab is that terminal's tab when Herdr labels it.
// what: the noun for the text in the notes and the record ("fix text", "question", "review"); by: the copy that
// opened the tab; prUrl: the PR the text is for. onOpen({ delivery, name }) runs once the tab exists, before any wait.
export async function startAgentTab(cx, { profile, space, folder, name, argv, text, what = "text", prUrl = null, by = null, focus = true, stopped = () => false, onOpen = () => {} }) {
  const delivery = tabTaskDelivery(profile), open = { space, folder, name, argv };
  if (!focus) open.focus = false;
  if (delivery === "arg") open.task = text; // the documented way to start Claude Code on a prompt
  const since = Date.now();
  run("tab.new", open);
  onOpen({ delivery, name });
  if (delivery === "arg") return { delivery, name, sent: true, stopped: false, terminal: null, tab: null };
  const rec = { id: `${since.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name, space, folder, text, what, prUrl, at: since, by };
  const recorded = await recordPending(rec);
  const found = await waitReady(cx, { space, name, since, stopped });
  if (found.stopped) return { delivery, name, sent: false, stopped: true, terminal: null, tab: null };
  if (!found.address) return { delivery, name, sent: false, stopped: false, terminal: null, tab: null };
  // Claimed before the send: a tick of another copy that took the record sends the text instead, and this copy never
  // sends it a second time.
  if (recorded) {
    const claim = await claimPending(rec.id);
    if (claim === "gone") return { delivery, name, sent: true, stopped: false, terminal: found.address, tab: found.tab ?? null };
    if (claim === "busy") return { delivery, name, sent: false, stopped: false, terminal: null, tab: null }; // a tick will send it
  }
  const r = await hc(["send", found.address, text]);
  if (r?.code !== 0) { await restorePending(rec); throw new Error((r?.stderr || r?.stdout || `hc send ${found.address}`).trim().slice(0, 200)); }
  return { delivery, name, sent: true, stopped: false, terminal: found.address, tab: found.tab ?? null };
}

// One pass over the pending deliveries, for a copy that just started or on its 2 s tick: sends each record whose tab's
// agent is ready, drops the ones older than fifteen minutes or out of tries with one note, and leaves the rest. Returns
// one entry per record looked at ({id, name, action}). uid: the copy running the pass (a record of another copy says
// "after a reload"); note(text): where the one sentence goes. Two copies that pass at the same moment send once: the
// claim is a compare-and-swap write that removes the record before `hc send`.
export async function deliverPending({ uid = null, note = () => {}, now = Date.now() } = {}) {
  const out = [], say = (text) => { if (text) note(text); };
  for (const rec of await readPending()) {
    // Age and tries first: a record that is too old or out of tries is dropped without asking Herdr about its tab.
    const state = pendingState(rec, null, now);
    if (state !== "wait") {
      const claim = await claimPending(rec.id);
      if (claim !== "taken") { out.push({ id: rec.id, name: rec.name, action: claim === "gone" ? "taken" : "wait" }); continue; }
      say(state === "expire" ? pendingExpiredNote(rec.name, rec.what) : pendingFailedNote(rec.name, rec.what, rec.tries));
      out.push({ id: rec.id, name: rec.name, action: state === "expire" ? "expired" : "dropped" });
      continue;
    }
    // The copy that opened the tab gets its grace: it may still be finishing its own send.
    if (now - rec.at < PENDING_GRACE_MS) { out.push({ id: rec.id, name: rec.name, action: "wait" }); continue; }
    const terminal = await findTab({ space: rec.space, name: rec.name, since: rec.at });
    if (!agentReady(terminal)) { out.push({ id: rec.id, name: rec.name, action: "wait" }); continue; }
    const claim = await claimPending(rec.id);
    if (claim !== "taken") { out.push({ id: rec.id, name: rec.name, action: claim === "gone" ? "taken" : "wait" }); continue; }
    const r = await hc(["send", terminal.address, rec.text]).catch((e) => ({ code: 1, stderr: String(e) }));
    if (r?.code !== 0) {
      const back = await restorePending(rec);
      if (!back) say(pendingFailedNote(rec.name, rec.what, rec.tries + 1));
      out.push({ id: rec.id, name: rec.name, action: "failed" });
      continue;
    }
    say(pendingSentNote(rec.name, rec.what, rec.by !== uid));
    out.push({ id: rec.id, name: rec.name, action: "sent" });
  }
  return out;
}
