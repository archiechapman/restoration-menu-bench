// A restoration plan's AC consequences, in tellegen, in the browser.
//
// For each period t = 0..T: damaged components repaired by t are in service, the network
// splits into islands, gen-less islands are de-energized (run.jl's deenergize_deadislands!),
// and each energized island is solved as its own case (tellegen 0.2 takes one reference bus
// per case). This stands in for the paper's PowerModelsRestoration SOC redispatch, which
// tellegen cannot run directly: its `shed` option is DC-only, and SOCWR ignores generator
// capability curves (checked 15 Sep 2026). Per island, all SOCWR:
//
//   1. relaxation: each load is a MATPOWER-style dispatchable load (a negative generator,
//      p ∈ [−Pd, 0], cost VOLL) with Q free in [0, Qd]; each shunt a zero-cost reactive-only
//      generator (continuously switchable, as PMR's shedding formulation treats shunts).
//   2. tied: every load fixed at its pass-1 share with Q = share·Qd (constant power factor,
//      as PMR sheds P and Q with one z), shunts still switchable. If that has no operating
//      point, each load that took reactive relief in pass 1 is cut to the share of Q it got;
//      failing that, those loads are shed together by bisection (all loads, if none took
//      relief). This is the reactive-limited shedding PMR does on load 23 / bus 28.
//   3. nameplate: pass 2's loads with every shunt at nameplate. Failing = the island relies
//      on shunt switching (a reactive dependence ENS alone does not show).
//
// Fixed loads are backed off by 1 − 1e-5: an island running its only unit exactly at pmax has
// no interior, and Clarabel calls that infeasible.

const VOLL = 1e4;              // $/MWh on shed load; pglib gen costs are tens of $/MWh
const BACKOFF = 1 - 1e-5;
const BISECT = 7;              // shed resolution 2^-7 of the relieved loads

/** items = [{type: "z_branch"|"z_gen", id}] (PM ids = MATPOWER rows) in feature order;
 *  tau[e] = the period item e is back in service (1..T). */
export function inService(base, items, tau, t) {
  const br = base.branches.map((b) => b.in_service);
  const gen = base.generators.map((g) => g.in_service);
  items.forEach((it, e) => {
    const on = tau[e] <= t;
    if (it.type === "z_branch") br[it.id - 1] = br[it.id - 1] && on;
    else if (it.type === "z_gen") gen[it.id - 1] = gen[it.id - 1] && on;
  });
  return { br, gen };
}

/** Energized islands (sorted bus-id arrays, largest first) and the de-energized buses. */
export function islands(base, st) {
  const parent = new Map(base.buses.map((b) => [b.id, b.id]));
  const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
  base.branches.forEach((b, i) => { if (st.br[i]) parent.set(find(b.from), find(b.to)); });
  const comp = new Map();
  for (const b of base.buses) {
    if (b.kind === "ISOLATED") continue;
    const r = find(b.id);
    comp.has(r) ? comp.get(r).push(b.id) : comp.set(r, [b.id]);
  }
  const genBuses = new Set(base.generators.filter((_, j) => st.gen[j]).map((g) => g.bus));
  const live = [], dead = [];
  for (const c of comp.values()) (c.some((b) => genBuses.has(b)) ? live : dead).push(c.sort((a, b) => a - b));
  live.sort((a, b) => b.length - a.length || a[0] - b[0]);
  return { live, dead: dead.flat().sort((a, b) => a - b) };
}

const genTemplate = (bus, uid) => ({
  bus, pg: 0, qg: 0, pmax: 0, pmin: 0, qmax: 0, qmin: 0, vg: 1, mbase: 100, in_service: true,
  cost: { model: 2, startup: 0, shutdown: 0, ncost: 2, coeffs: [0, 0] }, caps: {},
  regulated_bus: null, uid,
});

/** One island as a tellegen network. loads: "shed" | per-load factors (P and Q scaled
 *  together); shunts: "switch" | "nameplate". Appended generators carry uid "shed:k" /
 *  "shunt:k" so a solution can be read back. */
export function islandNetwork(base, st, members, { loads, shunts }) {
  const inI = new Set(members);
  const kindOf = new Map(base.buses.map((b) => [b.id, b.kind]));
  const net = structuredClone(base);
  const gens = net.generators.map((g, j) => ({ ...g, in_service: st.gen[j] && inI.has(g.bus) }));
  const live = gens.filter((g) => g.in_service);
  const origRef = base.buses.find((b) => b.kind === "REF")?.id;
  const ref = live.some((g) => g.bus === origRef)
    ? origRef
    : live.reduce((a, g) => (g.pmax > a.pmax || (g.pmax === a.pmax && g.bus < a.bus) ? g : a)).bus;
  const genBus = new Set(live.map((g) => g.bus));
  net.buses = net.buses.map((b) => ({
    ...b,
    kind: !inI.has(b.id) || kindOf.get(b.id) === "ISOLATED" ? "ISOLATED"
      : b.id === ref ? "REF" : genBus.has(b.id) ? "PV" : "PQ",
  }));
  net.branches = net.branches.map((b, i) => ({ ...b, in_service: st.br[i] && inI.has(b.from) && inI.has(b.to) }));
  net.loads = net.loads.map((l) => ({ ...l, in_service: l.in_service && inI.has(l.bus) }));
  net.shunts = net.shunts.map((s) => ({ ...s, in_service: s.in_service && inI.has(s.bus) }));

  net.loads.forEach((l, k) => {
    if (!l.in_service) return;
    if (loads === "shed") {
      const g = genTemplate(l.bus, `shed:${k}`);
      Object.assign(g, { pmin: -l.p, qmin: Math.min(0, -l.q), qmax: Math.max(0, -l.q) });
      g.cost.coeffs = [VOLL, 0];
      gens.push(g);
      l.in_service = false;
    } else {
      const f = loads[k] * BACKOFF;
      l.p *= f; l.q *= f;
      if (f <= 0) l.in_service = false;
    }
  });
  if (shunts === "switch") {
    net.shunts.forEach((s, k) => {
      if (!s.in_service) return;
      const g = genTemplate(s.bus, `shunt:${k}`);
      Object.assign(g, { qmin: Math.min(0, s.b), qmax: Math.max(0, s.b) });
      gens.push(g);
      s.in_service = false;
    });
  }
  net.generators = gens;
  return net;
}

function solve(tg, net) {
  try {
    const study = new tg.Study(JSON.stringify(net), "socwr");
    const sol = JSON.parse(study.solution());
    study.free();
    return sol;
  } catch (e) {
    const msg = String(e?.message ?? e);
    return { status: /infeasib/i.test(msg) ? "infeasible" : "error", error: msg };
  }
}

/** Solve one island: returns per-load served factors and the tied solution. */
function solveIsland(tg, base, st, members) {
  const nL = base.loads.length;
  const net1 = islandNetwork(base, st, members, { loads: "shed", shunts: "switch" });
  const relax = solve(tg, net1);
  if (relax.status !== "optimal") {
    const zero = new Array(nL).fill(0);
    return { status: relax.status, hi: zero, f: zero, limited: false, shedForQ: 0, nameplate: "skipped" };
  }

  const pF = new Array(nL).fill(0), qF = new Array(nL).fill(0);
  for (const d of relax.dispatch) {
    const uid = net1.generators[d.gen - 1]?.uid ?? "";
    if (!uid.startsWith("shed:")) continue;
    const k = +uid.slice(5), l = base.loads[k];
    pF[k] = l.p > 0 ? Math.min(1, Math.max(0, -d.pg / l.p)) : 0;
    qF[k] = l.q !== 0 ? Math.min(1, Math.max(0, -(d.qg ?? 0) / l.q)) : pF[k];
  }
  // Pass 1 is degenerate in Q (relief is free, and the interior point spreads it over every
  // load), so it cannot say which loads PMR would shed; the bisection sheds all relieved
  // loads together and is therefore pessimistic. Tellegen's SOCWR has no reactive cost and
  // ignores capability curves, so there is no exact tie; the demo reports the bracket.
  const relieved = pF.map((p, k) => p - qF[k] > 1e-3);
  const tiedAt = (a) => pF.map((p, k) => (relieved[k] || !relieved.some(Boolean) ? a * p : p));
  const tied = (f) => solve(tg, islandNetwork(base, st, members, { loads: f, shunts: "switch" }));

  let f = pF, sol = tied(f);
  const limited = sol.status !== "optimal";
  if (limited) {
    let lo = 0, hi = 1, best = null;
    for (let i = 0; i < BISECT; i++) {
      const a = (lo + hi) / 2, s = tied(tiedAt(a));
      if (s.status === "optimal") { lo = a; best = s; } else hi = a;
    }
    if (!best) { const s0 = tied(tiedAt(0)); if (s0.status === "optimal") best = s0; }
    if (best) { f = tiedAt(lo); sol = best; }
  }
  const shedForQ = sol.status === "optimal" ? pF.reduce((s, p, k) => s + (p - f[k]) * base.loads[k].p, 0) : 0;
  const plate = sol.status === "optimal"
    ? solve(tg, islandNetwork(base, st, members, { loads: f, shunts: "nameplate" })).status : "skipped";
  return { status: sol.status, hi: pF, f, sol, limited, shedForQ, nameplate: plate };
}

/** The evaluation, rounded for shipping to the page (MW to 0.1, p.u. to 1e-4). */
export function compact(r) {
  const rd = (x, d) => (x == null ? null : +x.toFixed(d));
  const obj = (o, d) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, rd(v, d)]));
  return {
    ens: rd(r.ens_mw_periods, 1), ens_hi: rd(r.ens_hi_mw_periods, 1),
    reactive_periods: r.reactive_periods, shunt_periods: r.shunt_periods, no_ac_periods: r.no_ac_periods,
    periods: r.periods.map((p) => ({
      t: p.t, served_mw: rd(p.served_mw, 1), served_lo_mw: rd(p.served_lo_mw, 1), load_mw: rd(p.load_mw, 1),
      pg_mw: rd(p.pg_mw, 1), qg_mvar: rd(p.qg_mvar, 1), vmin: rd(p.vmin, 4), vmax: rd(p.vmax, 4),
      max_loading: rd(p.max_loading, 3), dead_buses: p.dead_buses,
      islands: p.islands.map((i) => ({ buses: i.buses, status: i.status, limited: i.limited, nameplate: i.nameplate,
                                       served_mw: rd(i.served_mw, 1), served_lo_mw: rd(i.served_lo_mw, 1) })),
      flags: p.flags.map((f) => ({ kind: f.kind, island: f.island, text: f.text })),
      served: p.served.map((v) => rd(v, 1)), served_lo: p.served_lo.map((v) => rd(v, 1)),
      vm: obj(p.vm, 4), loading: obj(p.loading, 3),
    })),
  };
}

/** Per-period AC consequences of one plan. `base` is an ingested tellegen network. */
export function evaluatePlan(tg, base, items, tau, T, onPeriod) {
  const loadMw = base.loads.reduce((s, l) => s + (l.in_service ? l.p : 0), 0);
  const periods = [];
  for (let t = 0; t <= T; t++) {
    const st = inService(base, items, tau, t);
    const { live, dead } = islands(base, st);
    const served = new Array(base.loads.length).fill(0);     // upper bound (relaxation)
    const servedLo = new Array(base.loads.length).fill(0);   // a tied, AC-consistent point
    const vm = {}, loading = {}, flags = [];
    let pg = 0, qg = 0;
    const isl = live.map((members, j) => {
      const r = solveIsland(tg, base, st, members);
      r.hi.forEach((f, k) => { if (f > 0) served[k] = f * base.loads[k].p; });
      r.f.forEach((f, k) => { if (f > 0) servedLo[k] = f * base.loads[k].p; });
      if (r.status === "optimal") {
        const inI = new Set(members);
        for (const x of r.sol.w ?? []) if (inI.has(x.bus)) vm[x.bus] = Math.sqrt(x.value);
        for (const x of r.sol.flows ?? []) if (Number.isFinite(x.loading) && st.br[x.branch - 1]) loading[x.branch] = x.loading;
        for (const d of r.sol.dispatch ?? []) if (d.gen <= base.generators.length) { pg += d.pg; qg += d.qg ?? 0; }
      }
      const tag = `island ${j + 1} (${members.length} buses)`;
      if (r.status !== "optimal") flags.push({ island: j + 1, kind: "no-ac-point", text: `${tag}: no AC operating point (${r.status})` });
      if (r.limited) flags.push({ island: j + 1, kind: "reactive-limited", mw: r.shedForQ,
        text: `${tag}: reactive-limited; up to ${r.shedForQ.toFixed(0)} MW more shed at constant power factor` });
      if (r.nameplate !== "optimal" && r.status === "optimal") flags.push({ island: j + 1, kind: "shunt-switching", text: `${tag}: needs shunt switching` });
      return { buses: members, status: r.status, limited: r.limited, nameplate: r.nameplate,
               served_mw: r.hi.reduce((s, f, k) => s + f * base.loads[k].p, 0),
               served_lo_mw: r.f.reduce((s, f, k) => s + f * base.loads[k].p, 0) };
    });
    const vms = Object.values(vm);
    const p = {
      t, islands: isl, dead_buses: dead, served, served_lo: servedLo, vm, loading, flags,
      served_mw: served.reduce((a, b) => a + b, 0), served_lo_mw: servedLo.reduce((a, b) => a + b, 0),
      load_mw: loadMw, pg_mw: pg, qg_mvar: qg,
      vmin: vms.length ? Math.min(...vms) : null, vmax: vms.length ? Math.max(...vms) : null,
      max_loading: Object.values(loading).reduce((a, b) => Math.max(a, b), 0),
      repaired: items.flatMap((it, e) => (tau[e] === t ? [it] : [])),
    };
    periods.push(p);
    onPeriod?.(p);
  }
  const plateau = periods[T].served_mw;
  const flagged = (kind) => periods.filter((p) => p.flags.some((f) => f.kind === kind)).map((p) => p.t);
  return {
    periods,
    ens_mw_periods: periods.reduce((s, p) => s + (plateau - p.served_mw), 0),
    ens_hi_mw_periods: periods.reduce((s, p) => s + (plateau - p.served_lo_mw), 0),
    reactive_periods: flagged("reactive-limited"),
    shunt_periods: flagged("shunt-switching"),
    no_ac_periods: flagged("no-ac-point"),
  };
}
