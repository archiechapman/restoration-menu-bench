// Assemble the site into docs/: the page, the two workers, both wasm engines, and the data.
// Also evaluates the paper's plans in tellegen now, so the page opens populated.
//
//     node explorer/build.mjs        (after the milp/rs wasm build; see README)
//     node explorer/serve.mjs        -> http://localhost:8118

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tg from "../node_modules/@tellegen/engine/dist/wasm-pkg/tellegen.js";
import { evaluatePlan, compact } from "./restore.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const inputs = path.join(root, "inputs");
const docs = path.join(root, "docs");
const data = path.join(docs, "data");
fs.rmSync(docs, { recursive: true, force: true });
fs.mkdirSync(data, { recursive: true });

const tgPkg = path.join(root, "node_modules/@tellegen/engine/dist/wasm-pkg");
const ropPkg = path.join(root, "milp/rs/pkg");
const copies = [
  [path.join(here, "index.html"), "index.html"],
  [path.join(here, "app.js"), "app.js"],
  [path.join(here, "restore.mjs"), "restore.mjs"],
  [path.join(here, "milp.worker.js"), "milp.worker.js"],
  [path.join(here, "ac.worker.js"), "ac.worker.js"],
  [path.join(tgPkg, "tellegen.js"), "tellegen.js"],
  [path.join(tgPkg, "tellegen_bg.wasm"), "tellegen_bg.wasm"],
  [path.join(ropPkg, "rop_deflate.js"), "rop_deflate.js"],
  [path.join(ropPkg, "rop_deflate_bg.wasm"), "rop_deflate_bg.wasm"],
  [path.join(inputs, "case118.m"), "data/case118.m"],
  [path.join(inputs, "lp.json"), "data/lp.json"],
  [path.join(inputs, "side.json"), "data/side.json"],
];
for (const [from, to] of copies) fs.copyFileSync(from, path.join(docs, to));
fs.cpSync(path.join(root, "licenses"), path.join(docs, "licenses"), { recursive: true });
fs.writeFileSync(path.join(docs, ".nojekyll"), "");

tg.initSync({ module: fs.readFileSync(path.join(tgPkg, "tellegen_bg.wasm")) });
const caseText = fs.readFileSync(path.join(inputs, "case118.m"), "utf8");
const base = JSON.parse(JSON.parse(tg.ingest_case(Buffer.from(caseText), "matpower")).network_json);
const side = JSON.parse(fs.readFileSync(path.join(inputs, "side.json"), "utf8"));
const layout = JSON.parse(fs.readFileSync(path.join(inputs, "layout.json"), "utf8"));
const paper = JSON.parse(fs.readFileSync(path.join(inputs, "paper_plans.json"), "utf8"));

// PGLib leaves each generator's fuel tag in the row comment (SYNC = synchronous condenser).
const genBlock = caseText.match(/mpc\.gen\s*=\s*\[([\s\S]*?)\n\s*\];/)[1];
const tags = genBlock.split("\n").filter((l) => l.split("%")[0].trim()).map((l) => (l.split("%")[1] ?? "").trim());

const kv = new Map(base.buses.map((b) => [b.id, b.base_kv]));
const net = {
  baseMVA: base.base_mva,
  buses: base.buses.map((b) => ({ id: b.id, kv: b.base_kv, xy: layout[String(b.id)] })),
  branches: base.branches.map((b) => ({ from: b.from, to: b.to, xfmr: kv.get(b.from) !== kv.get(b.to) || (b.tap && b.tap !== 1) })),
  gens: base.generators.map((g, j) => ({ bus: g.bus, pmax: g.pmax, qmax: g.qmax, tag: tags[j] ?? "" })),
  loads: base.loads.map((l) => ({ bus: l.bus, p: l.p, q: l.q })),
  items: side.items.map((it) => {
    if (it.type === "z_branch") {
      const b = base.branches[it.id - 1];
      return { ...it, label: `Line ${b.from}–${b.to}`, detail: `branch ${it.id} · ${kv.get(b.from)} kV` };
    }
    const g = base.generators[it.id - 1], tag = tags[it.id - 1] ?? "";
    const what = tag === "SYNC" ? `condenser ${g.qmax.toFixed(0)} Mvar` : `${tag || "unit"} ${g.pmax.toFixed(0)} MW`;
    return { ...it, label: `Unit ${it.id} · bus ${g.bus}`, detail: what };
  }),
  T: side.T,
};
fs.writeFileSync(path.join(data, "net.json"), JSON.stringify(net));

const plans = [];
let outside = 0;
for (const m of paper.menus) {
  m.plans.forEach((p, i) => {
    const t0 = performance.now();
    const ev = compact(evaluatePlan(tg, base, side.items, p.tau, side.T));
    const inside = ev.periods.every((x, t) => p.paper_served[t] <= x.served_mw + 0.5 && p.paper_served[t] >= x.served_lo_mw - 0.5);
    if (!inside) outside++;
    console.log(`${m.key} plan ${i + 1}: ${(performance.now() - t0).toFixed(0)} ms, paper ${inside ? "inside" : "OUTSIDE"} the bracket`);
    plans.push({ id: `P${m.key.slice(1)}_${i + 1}`, name: `${m.key} · plan ${i + 1}`, menu_label: m.label, origin: "paper",
                 tau: p.tau, q: p.q, proven: true, paper_served: p.paper_served, eval: ev });
  });
}
fs.writeFileSync(path.join(data, "published.json"), JSON.stringify({ z_star: paper.z_star, plans }));

const size = (f) => (fs.statSync(path.join(docs, f)).size / 1024).toFixed(0) + " KB";
console.log(`docs/ ready: ${plans.length} paper plans, ${outside} outside the bracket; ` +
            `rop_deflate_bg.wasm ${size("rop_deflate_bg.wasm")}, tellegen_bg.wasm ${size("tellegen_bg.wasm")}, published.json ${size("data/published.json")}`);
