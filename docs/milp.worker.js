// The deflation MILP (microlp, compiled to wasm) in its own thread: every solve blocks for up
// to its time limit, so the page stays live while it runs. One Session per (ε, time limit);
// each message returns one event.

import init, { Session } from "./rop_deflate.js";

let lp, side, session = null;
const ready = (async () => {
  await init();
  [lp, side] = await Promise.all(["data/lp.json", "data/side.json"].map((f) => fetch(f).then((r) => r.text())));
  postMessage({ type: "ready" });
})().catch((e) => postMessage({ type: "fatal", message: String(e?.message ?? e) }));

const event = (json) => postMessage({ type: "event", ev: JSON.parse(json) });

onmessage = async ({ data: m }) => {
  await ready;
  try {
    switch (m.type) {
      case "reset":
        session?.free();
        session = new Session(lp, side, JSON.stringify(m.opts));
        for (const tau of m.exclude) session.exclude(Float64Array.from(tau));
        break;
      case "exclude": session.exclude(Float64Array.from(m.tau)); break;
      case "set_d": session.set_d(m.d); break;
      case "step": event(session.step()); break;
      case "resume": event(session.resume()); break;
    }
  } catch (e) {
    postMessage({ type: "event", ev: { kind: "error", message: String(e?.message ?? e) } });
  }
};
