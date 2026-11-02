// Restoration Menu Bench: drag plans onto two benches, step through periods, and ask the
// MILP (microlp, in a worker) for alternatives that tellegen (another worker) evaluates.

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (x, d = 0) => (x == null || !Number.isFinite(x) ? "–" : x.toLocaleString("en-AU", { minimumFractionDigits: d, maximumFractionDigits: d }));

const [net, pub] = await Promise.all(["data/net.json", "data/published.json"].map((f) => fetch(f).then((r) => r.json())));
const T = net.T;
const Z_OPT = pub.z_star;   // the paper's proven optimum (HiGHS, exact); anchors the band

const state = {
  plans: pub.plans,
  // The paper's mechanism: line 41 first vs line 33 first, one period in.
  slots: ["P60_1", "P60_2"],
  t: 1,
  playing: null,
  seq: { G: 0, D: 0 },
};
const byId = (id) => state.plans.find((p) => p.id === id);

// ── geometry ───────────────────────────────────────────────────────────────────────────
const W = 1000, H = 760, PAD = 26;
const xs = net.buses.map((b) => b.xy[0]), ys = net.buses.map((b) => b.xy[1]);
const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
const sc = Math.min((W - 2 * PAD) / (x1 - x0), (H - 2 * PAD) / (y1 - y0));
const P = new Map(net.buses.map((b) => [b.id, [PAD + (b.xy[0] - x0) * sc, H - PAD - (b.xy[1] - y0) * sc]]));
const kvOf = new Map(net.buses.map((b) => [b.id, b.kv]));
const genBuses = new Set(net.gens.map((g) => g.bus));
const loadsAt = new Map();
net.loads.forEach((l, k) => { if (!loadsAt.has(l.bus)) loadsAt.set(l.bus, []); loadsAt.get(l.bus).push(k); });
const distance = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);   // = Hamming on x

// ── workers ────────────────────────────────────────────────────────────────────────────
const lamp = (id, s) => $(id).setAttribute("data-state", s);
// A host that refuses module workers still gets the paper's menu, just no live engines.
const spawn = (url, lampId) => {
  try { return new Worker(url, { type: "module" }); }
  catch (e) { lamp(lampId, "error"); return { postMessage() {}, set onmessage(_) {} }; }
};
const milp = spawn("milp.worker.js", "#lamp-milp");
const ac = spawn("ac.worker.js", "#lamp-ac");
const gen = { ready: false, session: false, eps: null, busy: false, clock: null, t0: 0, phase: "" };

milp.onmessage = ({ data: m }) => {
  if (m.type === "ready") { gen.ready = true; lamp("#lamp-milp", "ready"); setStatus("Ready. Each search takes up to 15 s; if it runs out, Keep searching carries on from there."); renderGen(); }
  else if (m.type === "fatal") { lamp("#lamp-milp", "error"); setStatus(`The MILP engine did not load: ${m.message}`); }
  else if (m.type === "event") onEvent(m.ev);
};
const pendingEval = new Map();
ac.onmessage = ({ data: m }) => {
  if (m.type === "ready") { lamp("#lamp-ac", "ready"); pumpEval(); }
  else if (m.type === "fatal") lamp("#lamp-ac", "error");
  else if (m.type === "progress") { const p = byId(m.id); if (p) { p.progress = (m.t + 1) / (m.T + 1); renderCards(); } }
  else if (m.type === "result" || m.type === "failed") {
    const p = byId(m.id);
    if (p) { p.eval = m.eval ?? null; p.evalError = m.message; delete p.progress; }
    if (p && !gen.busy) setStatus(p.eval
      ? `${esc(p.name)}: unserved ${fmt(p.eval.ens)}–${fmt(p.eval.ens_hi)} MW·periods; reactive-limited in ${p.eval.reactive_periods.length} periods.`
      : `${esc(p.name)}: the AC evaluation failed (${esc(m.message)}).`);
    evalBusy = false; lamp("#lamp-ac", "ready"); renderAll(); pumpEval();
  }
};
let evalBusy = false;
function queueEval(p) { pendingEval.set(p.id, p.tau); pumpEval(); }
function pumpEval() {
  if (evalBusy || !pendingEval.size) return;
  const [id, tau] = pendingEval.entries().next().value;
  pendingEval.delete(id);
  evalBusy = true; lamp("#lamp-ac", "busy");
  byId(id).progress = 0; renderCards();
  ac.postMessage({ type: "evaluate", id, tau });
}

// ── generation ─────────────────────────────────────────────────────────────────────────
const dIn = $("#d"), epsIn = $("#eps");
dIn.addEventListener("input", () => {
  $("#d-out").textContent = `${dIn.value} decisions`;
});
// Existing cuts were made at the old d, so a new d needs a fresh session.
dIn.addEventListener("change", () => { gen.session = false; });
epsIn.addEventListener("change", () => { gen.session = false; log(`Cost band set to ${(+epsIn.value * 100).toFixed(1)}%; the next search starts afresh.`); });

function setStatus(html) { $("#status").innerHTML = html; }
function log(text) { const li = document.createElement("li"); li.textContent = text; $("#log").prepend(li); }
function tick() { setStatus(`${gen.phase} <span class="clock">${((performance.now() - gen.t0) / 1000).toFixed(1)} s</span>`); }
function busy(phase) {
  gen.busy = true; gen.phase = phase; gen.t0 = performance.now();
  clearInterval(gen.clock); gen.clock = setInterval(tick, 100); tick();
  lamp("#lamp-milp", "busy"); renderGen();
}
function idle(msg) {
  gen.busy = false; clearInterval(gen.clock); lamp("#lamp-milp", "ready");
  if (msg) setStatus(msg);
  renderGen();
}
function renderGen() {
  $("#go").disabled = !gen.ready || gen.busy;
  $("#more").disabled = gen.busy;
}

$("#go").addEventListener("click", () => {
  if (!gen.session) {
    gen.eps = +epsIn.value;
    milp.postMessage({
      type: "reset",
      opts: { k: 1000, d: +dIn.value, epsilon: gen.eps, time_limit: 15, mip_gap: 0.01, resumes: 0, incremental: true, z_star: Z_OPT },
      exclude: state.plans.map((p) => p.tau),
    });
    gen.session = true;
  }
  busy(`Searching for plan G${state.seq.G + 1}…`);
  $("#more").hidden = true;
  milp.postMessage({ type: "step" });
});
$("#more").addEventListener("click", () => {
  $("#more").hidden = true;
  busy(`Still searching for plan G${state.seq.G + 1}…`);
  milp.postMessage({ type: "resume" });
});

function onEvent(ev) {
  if (ev.kind === "plan") {
    const tau = ev.plan.tau.map(Math.round);
    const others = state.plans.map((p) => distance(tau, p.tau));
    const p = { id: `G${++state.seq.G}`, name: `Plan G${state.seq.G}`, origin: "generated", tau, q: ev.plan.q, proven: ev.plan.proven, eval: null };
    state.plans.push(p);
    state.slots[1] = p.id;
    log(`${p.name} · load delivered ${fmt(p.q, 2)} · ${ev.plan.t.toFixed(1)} s · ≥ ${Math.min(...others)} decisions from the rest`);
    idle(`Found ${p.name}; it is on bench B. Evaluating its AC consequences…`);
    queueEval(p);
    renderAll();
  } else if (ev.kind === "timeout") {
    idle(`15 s spent without a plan. Keep searching, or widen ε / lower <i>d</i>.`);
    $("#more").hidden = false;
  } else if (ev.kind === "exhausted") {
    gen.session = false;
    idle(`No plan is left within ${(gen.eps * 100).toFixed(1)}% of z* at distance ≥ ${dIn.value} from every plan in this library. That is a proof about this library, not a timeout; lower <i>d</i> or widen ε for more.`);
    log(`exhausted after ${ev.t.toFixed(1)} s`);
  } else if (ev.kind === "error") {
    gen.session = false;
    idle(`The solver stopped: ${esc(ev.message)}. The next search starts afresh.`);
  }
}

// ── dropping schedules in ──────────────────────────────────────────────────────────────
const lib = $("#library");
lib.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); lib.classList.add("drop-files"); } });
lib.addEventListener("dragleave", (e) => { if (!lib.contains(e.relatedTarget)) lib.classList.remove("drop-files"); });
lib.addEventListener("drop", async (e) => {
  lib.classList.remove("drop-files");
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  for (const f of e.dataTransfer.files) {
    try { addDropped(f.name, parseSchedule(await f.text())); }
    catch (err) { setStatus(`${esc(f.name)}: ${esc(err.message)}`); }
  }
});
function parseSchedule(text) {
  const tau = new Array(net.items.length).fill(null);
  for (const line of text.trim().split(/\r?\n/)) {
    const [c, id, period] = line.split(",").map((s) => s.trim());
    if (!c || /^component$/i.test(c)) continue;
    const type = c.startsWith("z_") ? c : `z_${c}`;
    const e = net.items.findIndex((it) => it.type === type && it.id === +id);
    if (e < 0) throw new Error(`${c} ${id} is not one of the 22 damaged components in this scenario.`);
    const t = +period;
    if (!(Number.isInteger(t) && t >= 1 && t <= T)) throw new Error(`${c} ${id}: period ${period} is outside 1–${T}.`);
    tau[e] = t;
  }
  const missing = net.items.filter((_, e) => tau[e] == null);
  if (missing.length) throw new Error(`no repair period for ${missing.map((m) => m.label).join(", ")}.`);
  return tau;
}
function addDropped(fname, tau) {
  const p = { id: `D${++state.seq.D}`, name: fname.replace(/\.csv$/i, ""), origin: "dropped", tau, q: null, eval: null };
  state.plans.push(p);
  state.slots[1] = p.id;
  if (gen.session) milp.postMessage({ type: "exclude", tau });
  setStatus(`Added ${esc(p.name)}; it is on bench B. Evaluating…`);
  queueEval(p);
  renderAll();
}

// ── benches: drag targets ──────────────────────────────────────────────────────────────
document.querySelectorAll(".slot").forEach((slot) => {
  const i = +slot.dataset.slot;
  slot.addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("text/plain")) { e.preventDefault(); slot.classList.add("over"); } });
  slot.addEventListener("dragleave", (e) => { if (!slot.contains(e.relatedTarget)) slot.classList.remove("over"); });
  slot.addEventListener("drop", (e) => {
    slot.classList.remove("over");
    const id = e.dataTransfer.getData("text/plain");
    if (!byId(id)) return;
    e.preventDefault();
    state.slots[i] = id;
    renderAll();
  });
});

// ── period scrubber ────────────────────────────────────────────────────────────────────
const periodsEl = $("#periods");
for (let t = 0; t <= T; t++) {
  const b = document.createElement("button");
  b.type = "button"; b.textContent = t; b.dataset.t = t;
  b.addEventListener("click", () => setT(t));
  periodsEl.append(b);
}
periodsEl.addEventListener("keydown", (e) => {
  if (e.key === "ArrowRight") { setT(Math.min(T, state.t + 1)); e.preventDefault(); }
  if (e.key === "ArrowLeft") { setT(Math.max(0, state.t - 1)); e.preventDefault(); }
});
function setT(t) { state.t = t; renderAll(); periodsEl.querySelector(`[data-t="${t}"]`)?.focus({ preventScroll: true }); }
$("#play").addEventListener("click", () => {
  if (state.playing) { clearInterval(state.playing); state.playing = null; $("#play").textContent = "Play"; return; }
  if (state.t >= T) state.t = 0;
  $("#play").textContent = "Pause";
  state.playing = setInterval(() => {
    if (state.t >= T) { clearInterval(state.playing); state.playing = null; $("#play").textContent = "Play"; return; }
    state.t++; renderAll();
  }, 1100);
});

// ── rendering ──────────────────────────────────────────────────────────────────────────
function badges(p) {
  if (!p.eval) return "";
  const b = [];
  if (p.eval.reactive_periods.length) b.push(`<span class="badge amber" title="Periods where the relaxation's load has no AC point at constant power factor">reactive-limited × ${p.eval.reactive_periods.length}</span>`);
  if (p.eval.shunt_periods.length) b.push(`<span class="badge violet" title="Periods where some island needs shunts switched off nameplate">shunt switching × ${p.eval.shunt_periods.length}</span>`);
  if (p.eval.no_ac_periods.length) b.push(`<span class="badge plain">no AC point × ${p.eval.no_ac_periods.length}</span>`);
  return b.join("");
}
const qLabel = (p) => (p.q == null ? "not from the MILP" : `${fmt(p.q, 2)} <small>${p.q >= Z_OPT - 1e-6 ? "optimal" : `${fmt(100 * (p.q - Z_OPT) / Z_OPT, 2)}%`}</small>`);
const ensLabel = (p) => (p.eval ? `${fmt(p.eval.ens)}–${fmt(p.eval.ens_hi)}` : "…");

function spark(p) {
  if (!p.eval) return `<svg class="spark" viewBox="0 0 96 34" aria-hidden="true"></svg>`;
  const hi = p.eval.periods.map((x) => x.served_mw), lo = p.eval.periods.map((x) => x.served_lo_mw);
  const min = Math.min(...lo) - 30, max = Math.max(...hi) + 10;
  const X = (t) => 2 + (t * 92) / T, Y = (v) => 32 - ((v - min) / (max - min)) * 30;
  const line = (a) => a.map((v, t) => `${X(t).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const band = `${line(hi)} ${lo.map((v, t) => `${X(t).toFixed(1)},${Y(v).toFixed(1)}`).reverse().join(" ")}`;
  return `<svg class="spark" viewBox="0 0 96 34" aria-hidden="true">
    <polygon points="${band}" fill="var(--amber)" fill-opacity="0.22"/>
    <polyline points="${line(hi)}" fill="none" stroke="var(--ink)" stroke-width="1.4"/>
    <circle cx="${X(T)}" cy="${Y(hi[T])}" r="2" fill="var(--ink)"/></svg>`;
}

function renderCards() {
  $("#lib-count").textContent = `${state.plans.length} plans`;
  $("#cards").innerHTML = state.plans.map((p) => {
    const slot = state.slots.indexOf(p.id);
    const origin = { paper: `Paper · ${p.menu_label ?? ""}`, generated: "Generated", dropped: "Dropped" }[p.origin];
    const prog = p.progress != null ? `<div class="progress" aria-label="AC evaluation progress"><i style="width:${(100 * p.progress).toFixed(0)}%"></i></div>` : "";
    return `<li class="card" draggable="true" data-id="${p.id}" ${slot >= 0 ? `data-slot="${slot}"` : ""}>
      <div class="card-top"><span class="chip ${p.origin}">${origin}</span><strong>${esc(p.name)}</strong>${slot >= 0 ? `<span class="where" style="color:var(--slot-${"ab"[slot]})">Bench ${"AB"[slot]}</span>` : ""}</div>
      <div class="card-body">${spark(p)}
        <dl class="stats"><div><dt>Load delivered</dt><dd>${qLabel(p)}</dd></div>
        <div><dt>Unserved, MW·periods</dt><dd>${p.evalError ? "failed" : ensLabel(p)}</dd></div></dl></div>
      ${prog}<div class="badges">${badges(p)}</div>
      <div class="card-actions"><button class="btn" type="button" data-to="0">To bench A</button><button class="btn" type="button" data-to="1">To bench B</button></div>
    </li>`;
  }).join("");
}
$("#cards").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-to]");
  if (!b) return;
  state.slots[+b.dataset.to] = b.closest(".card").dataset.id;
  renderAll();
});
$("#cards").addEventListener("dragstart", (e) => {
  const c = e.target.closest(".card");
  if (!c) return;
  e.dataTransfer.setData("text/plain", c.dataset.id);
  e.dataTransfer.effectAllowed = "copy";
});

function periodView(p, t) {
  const e = p.eval?.periods[t] ?? null;
  const brOut = new Set(), genOut = new Set(), brFixed = new Set(), genFixed = new Set();
  net.items.forEach((it, k) => {
    const isBr = it.type === "z_branch";
    if (p.tau[k] > t) (isBr ? brOut : genOut).add(isBr ? it.id - 1 : it.id - 1);
    if (p.tau[k] === t) (isBr ? brFixed : genFixed).add(it.id - 1);
  });
  const live = e ? new Set(e.islands.flatMap((i) => i.buses)) : null;
  const limited = e ? new Set(e.islands.filter((i) => i.limited).flatMap((i) => i.buses)) : new Set();
  return { e, brOut, genOut, brFixed, genFixed, live, limited };
}

function mapSvg(p, t) {
  const v = periodView(p, t);
  const parts = [];
  net.branches.forEach((br, i) => {
    const [xa, ya] = P.get(br.from), [xb, yb] = P.get(br.to);
    const on = v.live ? v.live.has(br.from) && v.live.has(br.to) : true;
    let cls, w = 2;
    if (v.brOut.has(i)) cls = "out";
    else if (v.brFixed.has(i)) cls = "fixed";
    else if (!on) cls = "dead";
    else {
      cls = Math.max(kvOf.get(br.from), kvOf.get(br.to)) >= 300 ? "kv345" : "kv138";
      w = 1.1 + 3.4 * Math.min(1.2, v.e?.loading[i + 1] ?? 0);
    }
    const ld = v.e?.loading[i + 1];
    parts.push(`<line class="br ${cls}" x1="${xa.toFixed(1)}" y1="${ya.toFixed(1)}" x2="${xb.toFixed(1)}" y2="${yb.toFixed(1)}"${cls.startsWith("kv") ? ` stroke-width="${w.toFixed(2)}"` : ""}><title>Branch ${i + 1}: ${br.from}–${br.to}${br.xfmr ? " (transformer)" : ""}${ld != null ? ` · ${fmt(100 * ld)}% loaded` : ""}${cls === "out" ? " · awaiting repair" : cls === "fixed" ? " · repaired this period" : cls === "dead" ? " · de-energized" : ""}</title></line>`);
    if (br.xfmr && cls !== "out") {
      const mx = (xa + xb) / 2, my = (ya + yb) / 2, dx = (xb - xa), dy = (yb - ya), L = Math.hypot(dx, dy) || 1;
      const ox = (dx / L) * 3.2, oy = (dy / L) * 3.2;
      parts.push(`<circle class="xf" cx="${(mx - ox).toFixed(1)}" cy="${(my - oy).toFixed(1)}" r="4.2"/><circle class="xf" cx="${(mx + ox).toFixed(1)}" cy="${(my + oy).toFixed(1)}" r="4.2"/>`);
    }
  });
  const genAt = new Map();
  net.gens.forEach((g, j) => { if (!genAt.has(g.bus)) genAt.set(g.bus, []); genAt.get(g.bus).push(j); });
  for (const b of net.buses) {
    const [x, y] = P.get(b.id);
    const ks = loadsAt.get(b.id) ?? [];
    const pd = ks.reduce((s, k) => s + net.loads[k].p, 0);
    const hi = v.e ? ks.reduce((s, k) => s + (v.e.served[k] ?? 0), 0) : pd;
    const lo = v.e ? ks.reduce((s, k) => s + (v.e.served_lo[k] ?? 0), 0) : pd;
    const live = v.live ? v.live.has(b.id) : true;
    const f = pd > 0 ? Math.max(0, Math.min(1, hi / pd)) : 1;
    // Shed only at constant power factor: the loads the served-load bracket is about.
    if (live && pd > 0 && hi - lo > 0.05) parts.push(`<circle class="halo" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9.5"/>`);
    const js = genAt.get(b.id) ?? [];
    const gOut = js.some((j) => v.genOut.has(j)), gFix = js.some((j) => v.genFixed.has(j));
    let cls = live ? "bus live" : "bus dead";
    if (live && pd === 0) cls += " noload";
    if (live && pd > 0 && f < 0.99) cls += " shed";
    const vm = v.e?.vm[b.id];
    const gtxt = js.map((j) => { const g = net.gens[j]; return `unit ${j + 1} ${g.tag === "SYNC" ? `condenser ${fmt(g.qmax)} Mvar` : `${g.tag} ${fmt(g.pmax)} MW`}${v.genOut.has(j) ? " (awaiting repair)" : ""}`; }).join("; ");
    const title = `Bus ${b.id} · ${b.kv} kV${live ? "" : " · de-energized"}${pd > 0 ? ` · load ${fmt(pd, 1)} MW, served ${fmt(hi, 1)}${Math.abs(hi - lo) > 0.05 ? ` (lower bound ${fmt(lo, 1)})` : ""}` : ""}${vm != null ? ` · |V| ${vm.toFixed(3)} p.u.` : ""}${gtxt ? ` · ${gtxt}` : ""}`;
    const fill = pd > 0 && live ? ` fill-opacity="${(0.15 + 0.85 * f).toFixed(2)}"` : "";
    if (js.length) {
      const gcls = gFix ? "gen fixed" : gOut ? "gen out" : cls;
      parts.push(`<g><title>${esc(title)}</title><rect class="${gcls}" x="${(x - 5.5).toFixed(1)}" y="${(y - 5.5).toFixed(1)}" width="11" height="11"${gOut || gFix ? "" : fill}/>${gOut ? `<path class="xmark" d="M${x - 4} ${y - 4}L${x + 4} ${y + 4}M${x + 4} ${y - 4}L${x - 4} ${y + 4}"/>` : ""}</g>`);
    } else {
      parts.push(`<circle class="${cls}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${pd > 0 ? 5 : 3.2}"${fill}><title>${esc(title)}</title></circle>`);
    }
  }
  return `<svg class="map" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(p.name)} in period ${t}">${parts.join("")}</svg>`;
}

function renderSlots() {
  document.querySelectorAll(".slot").forEach((el) => {
    const i = +el.dataset.slot, p = byId(state.slots[i]);
    if (!p) {
      el.innerHTML = `<div class="slot-head"><span class="slot-letter">${"AB"[i]}</span><div><h3>Bench ${"AB"[i]}</h3></div></div><div class="empty">Drag a plan here from the library.</div>`;
      return;
    }
    const t = state.t, e = p.eval?.periods[t];
    const repairs = net.items.filter((_, k) => p.tau[k] === t).map((it) => `${it.label} <small>(${it.detail})</small>`);
    const notes = [];
    if (repairs.length) notes.push(`<li class="repair">Repaired now: ${repairs.join(", ")}</li>`);
    else if (t === 0) notes.push(`<li>Before any repair: the storm's damage, all 22 components out.</li>`);
    for (const f of e?.flags ?? []) notes.push(`<li class="${f.kind}">${esc(f.text)}</li>`);
    const nIsl = e?.islands.length ?? 0;
    const dead = e?.dead_buses.length ?? 0;
    el.innerHTML = `<div class="slot-head"><span class="slot-letter">${"AB"[i]}</span>
        <div><h3>${esc(p.name)}</h3><p>${{ paper: `Paper menu, ${p.menu_label} (HiGHS, certified)`, generated: `Generated in the browser (microlp${p.proven ? ", within the 1% gap" : ", time-limited incumbent"})`, dropped: "Dropped-in schedule" }[p.origin]} · load delivered ${qLabel(p).replace(/<\/?small>/g, "")}</p></div></div>
      ${mapSvg(p, t)}
      <dl class="readout">
        <div><dt>Served</dt><dd>${e ? `${fmt(e.served_mw)} <small>MW</small>` : "…"}${e && Math.abs(e.served_mw - e.served_lo_mw) > 0.5 ? `<br><small>≥ ${fmt(e.served_lo_mw)} at const. PF</small>` : ""}</dd></div>
        <div><dt>Islands</dt><dd>${e ? nIsl : "…"}${dead ? ` <small>+ ${dead} dead bus${dead > 1 ? "es" : ""}</small>` : ""}</dd></div>
        <div><dt>|V| range</dt><dd>${e?.vmin != null ? `${e.vmin.toFixed(3)}–${e.vmax.toFixed(3)}` : "…"} <small>p.u.</small></dd></div>
        <div><dt>Worst loading</dt><dd>${e ? `${fmt(100 * e.max_loading)}%` : "…"}</dd></div>
      </dl>
      <ul class="notes">${notes.join("")}</ul>`;
  });
}

function renderScrubber() {
  periodsEl.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(+b.dataset.t === state.t)));
  const a = byId(state.slots[0]), b = byId(state.slots[1]);
  const n = (p) => (p ? net.items.filter((_, k) => p.tau[k] === state.t).length : 0);
  $("#period-caption").innerHTML = state.t === 0
    ? `<b>Period 0</b> · the damaged network, before any crew is out`
    : `<b>Period ${state.t}</b> of ${T} · repairs this period: ${a ? `A ${n(a)}` : ""}${a && b ? " · " : ""}${b ? `B ${n(b)}` : ""}`;
}

function renderChart() {
  const svg = $("#chart");
  const plans = state.slots.map(byId).map((p, i) => (p ? { p, i } : null)).filter(Boolean);
  const vals = plans.flatMap(({ p }) => [...(p.eval?.periods.flatMap((x) => [x.served_mw, x.served_lo_mw]) ?? []), ...(p.paper_served ?? [])]);
  const load = net.loads.reduce((s, l) => s + l.p, 0);
  const lo = Math.floor((Math.min(load, ...vals) - 60) / 200) * 200, hi = Math.ceil((load + 20) / 100) * 100;
  const L = 52, R = 14, Tp = 10, B = 30, Wc = 640, Hc = 270;
  const X = (t) => L + (t * (Wc - L - R)) / T, Y = (v) => Tp + ((hi - v) * (Hc - Tp - B)) / (hi - lo);
  const g = [];
  for (let v = lo; v <= hi; v += 200) g.push(`<line class="grid" x1="${L}" x2="${Wc - R}" y1="${Y(v)}" y2="${Y(v)}"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${fmt(v)}</text>`);
  for (let t = 0; t <= T; t++) g.push(`<text x="${X(t)}" y="${Hc - B + 16}" text-anchor="middle">${t}</text>`);
  g.push(`<text x="${L}" y="${Hc - 2}" text-anchor="start">period</text><text x="${L - 6}" y="${Tp - 0}" text-anchor="end" dy="-1">MW</text>`);
  g.push(`<line class="grid" x1="${L}" x2="${Wc - R}" y1="${Y(load)}" y2="${Y(load)}" stroke-dasharray="2 3"/><text x="${Wc - R}" y="${Y(load) - 4}" text-anchor="end">all load ${fmt(load)} MW</text>`);
  g.push(`<line class="cursor" x1="${X(state.t)}" x2="${X(state.t)}" y1="${Tp}" y2="${Hc - B}"/>`);
  for (const { p, i } of plans) {
    if (!p.eval) continue;
    const c = `var(--slot-${"ab"[i]})`;
    const up = p.eval.periods.map((x) => [X(x.t), Y(x.served_mw)]), dn = p.eval.periods.map((x) => [X(x.t), Y(x.served_lo_mw)]);
    const pts = (a) => a.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    g.push(`<polygon points="${pts(up)} ${pts([...dn].reverse())}" fill="${c}" fill-opacity="0.13"/>`);
    g.push(`<polyline points="${pts(dn)}" fill="none" stroke="${c}" stroke-width="1.3" stroke-dasharray="4 3"/>`);
    g.push(`<polyline points="${pts(up)}" fill="none" stroke="${c}" stroke-width="2.2"/>`);
    const [ex, ey] = up[state.t];
    g.push(`<circle cx="${ex}" cy="${ey}" r="3.6" fill="${c}"/>`);
    (p.paper_served ?? []).forEach((v, t) => g.push(`<circle cx="${X(t).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="3.4" fill="var(--surface)" stroke="${c}" stroke-width="1.5"><title>${esc(p.name)}, period ${t}: paper (PowerModels SOC) ${fmt(v, 1)} MW</title></circle>`));
  }
  svg.innerHTML = g.join("");
  $("#legend").innerHTML = plans.map(({ p, i }) => `<span><svg width="22" height="10" aria-hidden="true"><line x1="0" y1="5" x2="22" y2="5" stroke="var(--slot-${"ab"[i]})" stroke-width="2.2"/></svg>${"AB"[i]} · ${esc(p.name)}${p.eval ? ` · unserved ${fmt(p.eval.ens)}–${fmt(p.eval.ens_hi)} MW·periods` : " · evaluating…"}</span>`).join("") +
    `<span><svg width="22" height="10" aria-hidden="true"><line x1="0" y1="5" x2="22" y2="5" stroke="var(--muted)" stroke-width="1.3" stroke-dasharray="4 3"/></svg>constant-PF lower bound</span>` +
    `<span><svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="3.4" fill="none" stroke="var(--muted)" stroke-width="1.5"/></svg>paper (PowerModels)</span>`;
}

function renderMatrix() {
  const a = byId(state.slots[0]), b = byId(state.slots[1]);
  const head = `<tr><th scope="col" class="label" style="text-align:left">Component</th>${Array.from({ length: T }, (_, k) => `<th scope="col" class="${k + 1 === state.t ? "now" : ""}">${k + 1}</th>`).join("")}</tr>`;
  const rows = net.items.map((it, e) => {
    const ta = a?.tau[e], tb = b?.tau[e];
    const cells = Array.from({ length: T }, (_, k) => {
      const t = k + 1, ca = ta === t, cb = tb === t;
      const mk = ca || cb ? `<span class="mk${ca ? " a" : ""}${cb ? " b" : ""}" title="${[ca && `A (${a.name})`, cb && `B (${b.name})`].filter(Boolean).join(" and ")} repair ${it.label} in period ${t}"></span>` : "";
      return `<td class="${t === state.t ? "now" : ""}">${mk}</td>`;
    }).join("");
    return `<tr class="${a && b && ta !== tb ? "differs" : ""}"><th scope="row">${it.label}<small>${it.detail}</small></th>${cells}</tr>`;
  }).join("");
  const diff = a && b ? net.items.filter((_, e) => a.tau[e] !== b.tau[e]).length : 0;
  $("#matrix").innerHTML = `<table class="matrix"><thead>${head}</thead><tbody>${rows}</tbody></table>` +
    (a && b ? `<p class="hint" style="margin-top:6px"><span class="mk a"></span> A · <span class="mk b"></span> B · ${diff} of 22 components repaired in a different period; ${distance(a.tau, b.tau)} repair decisions apart.</p>` : "");
}

function renderAll() { renderCards(); renderScrubber(); renderSlots(); renderChart(); renderMatrix(); }
renderAll();
renderGen();
