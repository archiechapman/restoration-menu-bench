# Restoration Menu Bench

Compare restoration plans for the IEEE 118-bus case period by period, ask an in-browser MILP
for alternatives, and inspect their AC consequences. Both engines run as WebAssembly in the
browser, so the site is fully static.

It accompanies A. C. Chapman and M. Glencross, "Generating Alternative Options for Power System
Restoration Ordering", AUPEC 2026. **It is a demo, not evidence for the paper.**

## Credits

- [tellegen](https://github.com/eigenergy/tellegen), by Samuel Talkington and contributors
  (eigenergy, MIT): the AC evaluation, and the idea of running power system models in a browser.
- [microlp](https://github.com/Specy/microlp) (Apache-2.0): the in-browser MILP solver.
- [PGLib-OPF](https://github.com/power-grid-lib/pglib-opf) v23.07 (CC BY 4.0): the test case.
- [PowerModelsRestoration.jl](https://github.com/lanl-ansi/PowerModelsRestoration.jl) (Rhodes et
  al., BSD-3-Clause): the restoration model.

Licence texts are in `licenses/`. This repo's own code is BSD 3-Clause.

## What is in the library

The page opens with the paper's two certified menus, solved with HiGHS and evaluated with Ipopt:

| Menu | Plans | Objective | Unserved, SOC (p.u. × periods) | Unserved, DC |
|---|---|---|---|---|
| d = 60, ε = 0 | 12 | 959.59 | 8.164, 8.375 | 7.910 |
| d = 80, ε = 1% | 5 | 953.72–959.59 | 8.164–11.913 | 7.518–10.441 |

`inputs/paper_plans.json` holds these schedules. When it was generated, they were checked against
Table II and for pairwise separation, and each plan's objective was recomputed on the MILP.

## How far to trust the numbers

- **Generated plans** are valid: the band and the cuts are hard constraints. They may not be the
  best remaining, because each solve has a 15 s budget and a 1% MIP gap. The band is anchored on
  the paper's proven optimum, z* = 959.59.
- **"No plan left"** is a proof about the plans now in the library. A different set of plans could
  leave room for more. A timeout proves nothing.
- **AC figures are a range**, not PowerModels' number. tellegen 0.2 has no AC load shedding, so the
  upper line is a relaxation and the lower line a constant-power-factor operating point. The
  paper's served load is inside that range in every period of all 17 plans
  (`npm test`), to within the test's 0.5 MW tolerance.
- **Timing depends on the machine and varies between runs.** On the development laptop, the
  default d = 20 and ε = 1% found a plan in one or two 15 s rounds across three tests. Exactly
  optimal searches take longer: d = 10 and ε = 0 took four rounds in its one test.

## Run

The built site is committed in `docs/`:

```sh
npm install
npm run serve    # http://localhost:8118
```

## Rebuild

Needs Node, plus Rust with the `wasm32-unknown-unknown` target and `wasm-bindgen` 0.2.128.

```sh
npm install
cd milp/rs
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/rop_deflate.wasm
cd ../..
npm test
npm run build    # rewrites docs/
```

`inputs/` is exported from the DiverseSolutionsROP experiments: `lp.json` and `side.json` from the
ROP MILP, `layout.json` from the paper's network schematic, and `paper_plans.json` from its results.

## Publishing

The repo is private, and GitHub Pages is off. Pages sites are public even when the repo is private,
so don't enable it until the demo is meant to be seen. To publish:

```sh
gh repo edit --visibility public --accept-visibility-change-consequences
gh api repos/{owner}/{repo}/pages -X POST -f "source[branch]=main" -f "source[path]=/docs"
```

The site uses relative paths, so it works from the `/<repo>/` subpath Pages serves it from.
