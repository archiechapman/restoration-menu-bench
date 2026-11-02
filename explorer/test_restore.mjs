// Hold the in-browser AC evaluation (restore.mjs, tellegen SOCWR with dispatchable loads)
// against the paper's evaluation (PowerModelsRestoration SOC redispatch, Ipopt) on its two
// menus: total served load per period. Exits non-zero if the paper's number leaves the bracket.
//
//     node explorer/test_restore.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tg from "../node_modules/@tellegen/engine/dist/wasm-pkg/tellegen.js";
import { evaluatePlan } from "./restore.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, "inputs", f));
tg.initSync({ module: fs.readFileSync(path.join(root, "node_modules/@tellegen/engine/dist/wasm-pkg/tellegen_bg.wasm")) });

const base = JSON.parse(JSON.parse(tg.ingest_case(read("case118.m"), "matpower")).network_json);
const side = JSON.parse(read("side.json"));
const paper = JSON.parse(read("paper_plans.json"));

let worst = 0, outside = 0;
for (const m of paper.menus) {
  m.plans.forEach((p, i) => {
    const r = evaluatePlan(tg, base, side.items, p.tau, side.T);
    const gaps = r.periods.map((x, t) => x.served_mw - p.paper_served[t]);
    worst = Math.max(worst, ...gaps.map(Math.abs));
    const inside = r.periods.every((x, t) => p.paper_served[t] <= x.served_mw + 0.5 && p.paper_served[t] >= x.served_lo_mw - 0.5);
    if (!inside) {
      outside++;
      const bad = r.periods.filter((x, t) => !(p.paper_served[t] <= x.served_mw + 0.5 && p.paper_served[t] >= x.served_lo_mw - 0.5))
        .map((x) => `t${x.t}: ${x.served_lo_mw.toFixed(1)}–${x.served_mw.toFixed(1)} vs ${p.paper_served[x.t].toFixed(1)}`);
      console.log(`  ${m.key} plan ${i + 1} outside: ${bad.join("; ")}`);
    }
    console.log(`${m.key} plan ${i + 1}: unserved ${r.ens_mw_periods.toFixed(1)}–${r.ens_hi_mw_periods.toFixed(1)} MW·periods, paper SOC ${(100 * p.ens_soc).toFixed(1)}; ` +
                `${inside ? "inside" : "OUTSIDE"}; reactive-limited [${r.reactive_periods}], shunt switching [${r.shunt_periods}], no AC point [${r.no_ac_periods}]`);
  });
}
console.log(`\nlargest per-period gap to the upper line: ${worst.toFixed(2)} MW; plans outside the bracket: ${outside}`);
process.exit(outside ? 1 : 0);
