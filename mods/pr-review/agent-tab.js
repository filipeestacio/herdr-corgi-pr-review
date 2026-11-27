// Starting a new agent tab that gets PR text, once for the three paths that start one ("Main agent" fix, "Ask an
// agent…", "Send review"). pr.js tabTaskDelivery decides how the text arrives: Claude Code takes it as the last
// argument of its command, a harness `agent` launcher starts bare and gets it with `hc send` when its agent reports
// ready. A tab that never reports ready keeps its tab and gets nothing; the caller says so in a note.
import { hc, run } from "herdr";
import { agentReady, tabTaskDelivery, tabTerminal } from "./pr.js";

const POLL_MS = 500, READY_MS = 60000;
const pause = (cx, ms) => new Promise((done) => cx.timer.after(ms, done));
const doc = (text) => { try { return JSON.parse(String(text ?? "")); } catch { return null; } };
// `hc ls --json` prints {terminals: [...]}; a bare list is taken too, so a version that prints one still works.
const terminalsIn = (text) => { const d = doc(text); return Array.isArray(d) ? d : Array.isArray(d?.terminals) ? d.terminals : []; };
const getTerminal = async (address) => { const r = await hc(["get", address, "--json"]).catch(() => null); return r?.code === 0 ? doc(r.stdout) : null; };

// The terminal of the tab just started: `hc ls` names the tab in its `where`, and `hc get` says which space it is in
// (labels["herdr.space"]), when it was created and what its agent reports. The newest match wins: `hc` lists terminals
// in creation order, another space may hold a tab of the same name, and an older tab of that name may still be open.
async function findTab({ space, name, since }) {
  const r = await hc(["ls", "--json"]).catch(() => null);
  const named = terminalsIn(r?.stdout).filter((x) => Boolean(name) && typeof x?.where === "string" && x.where.includes(name));
  const got = await Promise.all(named.map((x) => getTerminal(x.address)));
  return tabTerminal(got.filter((t) => !Number.isFinite(t?.created_ms) || t.created_ms >= since - 2000), { space, name });
}

// Waits for that terminal's agent to report ready. Resolves { address } when it is ready, { address, finished: true }
// when its program ended first (a plain shell is never ready either), { stopped: true } when stopped() says the note
// is superseded, and {} when 60 s pass without either.
async function waitReady(cx, { space, name, since, stopped }) {
  const until = Date.now() + READY_MS;
  let found = null;
  for (;;) {
    if (stopped()) return { stopped: true };
    const t = found ? await getTerminal(found.address) : await findTab({ space, name, since });
    if (t) {
      found = t;
      if (agentReady(t)) return { address: t.address };
      if (t.state === "finished") return { address: t.address, finished: true };
    }
    if (Date.now() >= until) return { address: found?.address ?? null };
    await pause(cx, POLL_MS);
  }
}

// Starts the tab and gets the text there through the decision tabTaskDelivery makes. Resolves { delivery, name, sent,
// stopped }: sent is true when the argv held the text or `hc send` took it, stopped is true when the note was
// superseded while waiting (the caller then keeps whatever note replaced it). sent false with stopped false: the tab
// is up and the text was not sent. onOpen({ delivery, name }) runs once the tab exists, before any wait.
export async function startAgentTab(cx, { profile, space, folder, name, argv, text, focus = true, stopped = () => false, onOpen = () => {} }) {
  const delivery = tabTaskDelivery(profile), open = { space, folder, name, argv };
  if (!focus) open.focus = false;
  if (delivery === "arg") open.task = text; // the documented way to start Claude Code on a prompt
  const since = Date.now();
  run("tab.new", open);
  onOpen({ delivery, name });
  if (delivery === "arg") return { delivery, name, sent: true, stopped: false };
  const found = await waitReady(cx, { space, name, since, stopped });
  if (found.stopped) return { delivery, name, sent: false, stopped: true };
  if (!found.address) return { delivery, name, sent: false, stopped: false };
  const r = await hc(["send", found.address, text]);
  if (r?.code !== 0) throw new Error((r?.stderr || r?.stdout || `hc send ${found.address}`).trim().slice(0, 200));
  return { delivery, name, sent: true, stopped: false };
}
