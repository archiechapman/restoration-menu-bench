// A plan's AC consequences in tellegen (restore.mjs), in its own thread so a MILP solve and
// an evaluation can run side by side.

import init, * as tg from "./tellegen.js";
import { evaluatePlan, compact } from "./restore.mjs";

let base, side;
const ready = (async () => {
  await init();
  const bytes = new Uint8Array(await (await fetch("data/case118.m")).arrayBuffer());
  base = JSON.parse(JSON.parse(tg.ingest_case(bytes, "matpower")).network_json);
  side = await (await fetch("data/side.json")).json();
  postMessage({ type: "ready" });
})().catch((e) => postMessage({ type: "fatal", message: String(e?.message ?? e) }));

onmessage = async ({ data: m }) => {
  await ready;
  if (m.type !== "evaluate") return;
  try {
    const r = evaluatePlan(tg, base, side.items, m.tau, side.T,
      (p) => postMessage({ type: "progress", id: m.id, t: p.t, T: side.T }));
    postMessage({ type: "result", id: m.id, eval: compact(r) });
  } catch (e) {
    postMessage({ type: "failed", id: m.id, message: String(e?.message ?? e) });
  }
};
