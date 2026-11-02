//! `generate_menu` (DiverseSolutions.jl) with `HammingMetric`, on microlp: the loop of
//! `../deflate.mjs`, in pure Rust so it compiles to wasm alongside tellegen's engine.
//!
//! Demo policy: a solve may stop on its time limit or MIP gap.
//! A feasible incumbent is still a valid plan, since the band and the cuts are hard
//! constraints; it is just not proven the best remaining one (`Plan::proven`). Only a proof
//! of infeasibility is `Exhausted`.
//!
//! [`Session`] is the stateful form the explorer drives one plan at a time (so it can report
//! progress, resume a timed-out solve, and exclude plans already on the table);
//! [`generate_menu`] is the batch loop on top of it.

use microlp::{
    ComparisonOp, Error, LinearExpr, OptimizationDirection, Problem, Solution, SolutionStatus,
    SolveOptions, SolveOutcome, Variable,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use web_time::Instant;

/// `out/case118_rop_lp.json`: the model as matrix data (`export_mps.jl`). `null` bounds are
/// infinite; rows are CSR; `x_cols` are the deflation binaries in `solution_vars` order.
#[derive(Deserialize)]
pub struct Lp {
    pub sense: String,
    pub offset: f64,
    pub ncols: usize,
    pub nrows: usize,
    pub c: Vec<f64>,
    pub col_lower: Vec<Option<f64>>,
    pub col_upper: Vec<Option<f64>>,
    pub integer: Vec<usize>,
    pub row_lower: Vec<Option<f64>>,
    pub row_upper: Vec<Option<f64>>,
    pub a_start: Vec<usize>,
    pub a_index: Vec<usize>,
    pub a_value: Vec<f64>,
    pub x_cols: Vec<usize>,
}

/// The feature map from `out/case118_rop.json`: τ_e = offset_e − Σ_{i ∈ cols_e} x_i, with
/// `cols_e` the item's T binaries in period order (x_{e,n} = 1 once e is back, n ≥ τ_e).
#[derive(Deserialize, Clone)]
pub struct Features {
    pub feature_cols: Vec<Vec<usize>>,
    pub feature_offset: Vec<f64>,
}

impl Features {
    pub fn tau(&self, x: &[f64]) -> Vec<f64> {
        self.feature_cols
            .iter()
            .zip(&self.feature_offset)
            .map(|(cols, &b)| cols.iter().fold(b, |acc, &i| acc - x[i]))
            .collect()
    }

    /// The binaries of a schedule: the inverse of [`Features::tau`] for integer τ.
    pub fn x(&self, tau: &[f64]) -> Vec<f64> {
        let n = self.feature_cols.iter().map(|c| c.len()).sum();
        let mut x = vec![0.0; n];
        for (cols, &t) in self.feature_cols.iter().zip(tau) {
            for (k, &i) in cols.iter().enumerate() {
                x[i] = if (k + 1) as f64 >= t.round() { 1.0 } else { 0.0 };
            }
        }
        x
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Opts {
    pub k: usize,
    pub d: f64,
    pub epsilon: f64,
    /// Seconds per solve; `None` = unlimited.
    pub time_limit: Option<f64>,
    pub mip_gap: f64,
    /// Extra time-limit rounds (`resume`) a batch solve may take before giving up.
    pub resumes: usize,
    /// Add a single cut to the live solve (`Solution::add_constraint`) instead of rebuilding.
    pub incremental: bool,
    /// A known optimum to anchor the band on. Skips the base solve, whose time-limited
    /// result can sit below the true optimum and so widen the band past the stated ε.
    pub z_star: Option<f64>,
}

impl Default for Opts {
    fn default() -> Self {
        Opts { k: 5, d: 1.0, epsilon: 0.01, time_limit: None, mip_gap: 0.0, resumes: 0, incremental: true, z_star: None }
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct Plan {
    pub x: Vec<f64>,
    pub tau: Vec<f64>,
    pub q: f64,
    pub proven: bool,
    pub t: f64,
}

/// What one [`Session::step`] or [`Session::resume`] produced.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Event {
    /// The unconstrained optimum, which anchors the ε band.
    Base { z_star: f64, proven: bool, t: f64 },
    Plan { plan: Plan },
    /// Budget spent with no incumbent: none found yet, NOT a certificate. `resume` continues.
    Timeout { t: f64 },
    /// Proven: no further plan within ε of z* at Hamming distance ≥ d from all excluded.
    Exhausted { t: f64 },
    Error { message: String },
}

enum State {
    Fresh,
    Live(Box<Solution>),
    Interrupted(Box<SolveOutcome>),
    Done,
}

pub struct Session {
    prob: Problem,
    band: LinearExpr,
    x: Vec<Variable>,
    feats: Features,
    offset: f64,
    maximize: bool,
    opts: Opts,
    solve_opts: SolveOptions,
    state: State,
    z_star: Option<f64>,
    /// Constraints in `prob` that the live solve has not seen yet.
    unseen: Vec<(LinearExpr, ComparisonOp, f64)>,
    pending: Vec<Vec<f64>>,
    last: Option<Vec<f64>>,
    pub plans: Vec<Plan>,
    pub times: Vec<f64>,
}

fn build(lp: &Lp) -> (Problem, Vec<Variable>) {
    let dir = if lp.sense == "max" { OptimizationDirection::Maximize } else { OptimizationDirection::Minimize };
    let mut p = Problem::new(dir);
    let mut is_int = vec![false; lp.ncols];
    lp.integer.iter().for_each(|&j| is_int[j] = true);
    let vars: Vec<Variable> = (0..lp.ncols)
        .map(|j| {
            let lo = lp.col_lower[j].unwrap_or(f64::NEG_INFINITY);
            let hi = lp.col_upper[j].unwrap_or(f64::INFINITY);
            match (is_int[j], lo, hi) {
                (true, 0.0, 1.0) => p.add_binary_var(lp.c[j]),
                (true, _, _) => p.add_integer_var(
                    lp.c[j],
                    (lo.max(i32::MIN as f64) as i32, hi.min(i32::MAX as f64) as i32),
                ),
                (false, _, _) => p.add_var(lp.c[j], (lo, hi)),
            }
        })
        .collect();
    for i in 0..lp.nrows {
        let span = lp.a_start[i]..lp.a_start[i + 1];
        let row = || -> LinearExpr { span.clone().map(|k| (vars[lp.a_index[k]], lp.a_value[k])).collect() };
        match (lp.row_lower[i], lp.row_upper[i]) {
            (Some(l), Some(u)) if l == u => p.add_constraint(row(), ComparisonOp::Eq, l),
            (l, u) => {
                if let Some(l) = l { p.add_constraint(row(), ComparisonOp::Ge, l) }
                if let Some(u) = u { p.add_constraint(row(), ComparisonOp::Le, u) }
            }
        }
    }
    (p, vars)
}

impl Session {
    pub fn new(lp: &Lp, feats: Features, opts: Opts) -> Self {
        let (prob, vars) = build(lp);
        let band = (0..lp.ncols).filter(|&j| lp.c[j] != 0.0).map(|j| (vars[j], lp.c[j])).collect();
        let x = lp.x_cols.iter().map(|&j| vars[j]).collect();
        let mut solve_opts = SolveOptions::default();
        solve_opts.time_limit = opts.time_limit.map(Duration::from_secs_f64);
        solve_opts.mip_gap = opts.mip_gap;
        let mut s = Session {
            prob, band, x, feats, offset: lp.offset, maximize: lp.sense == "max", opts, solve_opts,
            state: State::Fresh, z_star: None, unseen: vec![], pending: vec![], last: None,
            plans: vec![], times: vec![],
        };
        if let Some(z) = s.opts.z_star {
            s.z_star = Some(z);
            let (e, op, r) = s.band_row(z);
            s.prob.add_constraint(e, op, r);
        }
        s
    }

    /// The ε band around z. The 1e-6 keeps ε = 0 from rejecting an optimum on rounding.
    fn band_row(&self, z: f64) -> (LinearExpr, ComparisonOp, f64) {
        let e = self.opts.epsilon;
        if self.maximize {
            (self.band.clone(), ComparisonOp::Ge, (1.0 - e) * z - 1e-6 - self.offset)
        } else {
            (self.band.clone(), ComparisonOp::Le, (1.0 + e) * z + 1e-6 - self.offset)
        }
    }

    pub fn z_star(&self) -> Option<f64> { self.z_star }
    pub fn features(&self) -> &Features { &self.feats }

    /// Hamming radius for the cuts made from here on.
    pub fn set_d(&mut self, d: f64) { self.opts.d = d; }

    /// Keep future plans at Hamming distance ≥ d from this schedule (a plan already on the
    /// table: a published one, or one dropped in). Applied at the next `step`.
    pub fn exclude(&mut self, tau: &[f64]) { self.pending.push(self.feats.x(tau)); }

    fn cut(&self, xk: &[f64]) -> (LinearExpr, ComparisonOp, f64) {
        // Σ_{x_k=0} x_i + Σ_{x_k=1} (1 − x_i) ≥ d, constants moved to the right-hand side.
        let ones = xk.iter().filter(|&&v| v > 0.5).count() as f64;
        let e = self.x.iter().zip(xk).map(|(&v, &b)| (v, if b > 0.5 { -1.0 } else { 1.0 })).collect();
        (e, ComparisonOp::Ge, self.opts.d - ones)
    }

    fn timed(&mut self, f: impl FnOnce(&mut Self) -> Result<SolveOutcome, Error>) -> (Result<SolveOutcome, Error>, f64) {
        let t = Instant::now();
        let r = f(self);
        let dt = t.elapsed().as_secs_f64();
        self.times.push(dt);
        (r, dt)
    }

    fn settle(&mut self, out: Result<SolveOutcome, Error>, t: f64) -> Event {
        match out {
            Ok(SolveOutcome::Solution(s)) => {
                if self.z_star.is_none() {
                    let z = s.objective() + self.offset;
                    self.z_star = Some(z);
                    let proven = s.status() == SolutionStatus::Optimal;
                    let band = self.band_row(z);
                    self.prob.add_constraint(band.0.clone(), band.1, band.2);
                    self.unseen.push(band);
                    self.state = State::Live(Box::new(s));
                    return Event::Base { z_star: z, proven, t };
                }
                let xv: Vec<f64> = self.x.iter().map(|&v| s.var_value_raw(v)).collect();
                let plan = Plan {
                    tau: self.feats.tau(&xv),
                    q: s.objective() + self.offset,
                    proven: s.status() == SolutionStatus::Optimal,
                    t,
                    x: xv.clone(),
                };
                self.last = Some(xv);
                self.plans.push(plan.clone());
                self.state = State::Live(Box::new(s));
                Event::Plan { plan }
            }
            Ok(o @ SolveOutcome::Interrupted(_)) => {
                self.state = State::Interrupted(Box::new(o));
                Event::Timeout { t }
            }
            Err(Error::Infeasible) => {
                self.state = State::Done;
                Event::Exhausted { t }
            }
            Err(e) => {
                self.state = State::Done;
                Event::Error { message: e.to_string() }
            }
        }
    }

    /// Solve for the next thing: z* first, then one plan per call.
    pub fn step(&mut self) -> Event {
        match std::mem::replace(&mut self.state, State::Done) {
            State::Fresh => {
                // With a known optimum this first solve already returns a plan, so it must
                // see the exclusions; otherwise they wait for the base solve to finish.
                if self.z_star.is_some() {
                    let cuts: Vec<_> = std::mem::take(&mut self.pending).iter().map(|x| self.cut(x)).collect();
                    for (e, op, r) in cuts {
                        self.prob.add_constraint(e, op, r);
                    }
                }
                let (out, t) = self.timed(|s| s.prob.solve_with(s.solve_opts.clone()));
                self.settle(out, t)
            }
            State::Live(sol) => {
                let mut new: Vec<_> = self.last.take().map(|x| self.cut(&x)).into_iter().collect();
                let excl: Vec<_> = std::mem::take(&mut self.pending).iter().map(|x| self.cut(x)).collect();
                new.extend(excl);
                for (e, op, r) in &new {
                    self.prob.add_constraint(e.clone(), *op, *r);
                }
                self.unseen.extend(new);
                let unseen = std::mem::take(&mut self.unseen);
                let (out, t) = if self.opts.incremental && unseen.len() == 1 {
                    let (e, op, r) = unseen.into_iter().next().unwrap();
                    self.timed(move |_| sol.add_constraint(e, op, r))
                } else {
                    self.timed(|s| s.prob.solve_with(s.solve_opts.clone()))
                };
                self.settle(out, t)
            }
            s @ State::Interrupted(_) => {
                self.state = s;
                Event::Error { message: "the last solve timed out; call resume".into() }
            }
            State::Done => Event::Error { message: "session finished".into() },
        }
    }

    /// Spend another time budget on a solve that timed out.
    pub fn resume(&mut self) -> Event {
        match std::mem::replace(&mut self.state, State::Done) {
            State::Interrupted(o) => {
                let (out, t) = self.timed(move |_| o.resume());
                self.settle(out, t)
            }
            s => {
                self.state = s;
                Event::Error { message: "nothing to resume".into() }
            }
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// K plans found.
    Budget,
    Exhausted,
    /// A solve hit its limits with no incumbent: none found in budget, NOT a certificate.
    Timeout,
    Error,
}

#[derive(Serialize, Debug)]
pub struct Menu {
    pub plans: Vec<Plan>,
    pub z_star: f64,
    pub z_star_proven: bool,
    pub status: Status,
    pub times: Vec<f64>,
    pub message: Option<String>,
}

/// The batch loop: `generate_menu` semantics on a [`Session`].
pub fn generate_menu(lp: &Lp, feats: &Features, opts: &Opts, mut on_plan: impl FnMut(&Plan, usize)) -> Menu {
    let mut s = Session::new(lp, feats.clone(), opts.clone());
    let (mut z_star, mut z_star_proven) = (f64::NAN, false);
    let mut status = Status::Budget;
    let mut message = None;
    let mut ev = s.step();
    let mut tries = 0;
    loop {
        match ev {
            Event::Timeout { .. } if tries < opts.resumes => {
                tries += 1;
                ev = s.resume();
                continue;
            }
            Event::Timeout { .. } => { status = Status::Timeout; break; }
            Event::Exhausted { .. } => { status = Status::Exhausted; break; }
            Event::Error { message: m } => { status = Status::Error; message = Some(m); break; }
            Event::Base { z_star: z, proven, .. } => { z_star = z; z_star_proven = proven; }
            Event::Plan { ref plan } => {
                on_plan(plan, s.plans.len());
                if s.plans.len() == opts.k { break; }
            }
        }
        tries = 0;
        ev = s.step();
    }
    Menu { plans: s.plans, z_star, z_star_proven, status, times: s.times, message }
}

pub fn hamming(a: &[f64], b: &[f64]) -> usize {
    a.iter().zip(b).filter(|(u, v)| (**u > 0.5) != (**v > 0.5)).count()
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    fn js<T: serde::Serialize>(v: &T) -> String { serde_json::to_string(v).unwrap() }

    /// One-shot entry point: model JSON, sidecar JSON, options JSON in; menu JSON out.
    #[wasm_bindgen]
    pub fn generate_menu_json(lp: &str, sidecar: &str, opts: &str) -> Result<String, JsError> {
        let lp: super::Lp = serde_json::from_str(lp)?;
        let feats: super::Features = serde_json::from_str(sidecar)?;
        let opts: super::Opts = serde_json::from_str(opts)?;
        Ok(js(&super::generate_menu(&lp, &feats, &opts, |_, _| {})))
    }

    /// The stateful session, for a Web Worker: each call returns one `Event` as JSON.
    #[wasm_bindgen]
    pub struct Session(super::Session);

    #[wasm_bindgen]
    impl Session {
        #[wasm_bindgen(constructor)]
        pub fn new(lp: &str, sidecar: &str, opts: &str) -> Result<Session, JsError> {
            let lp: super::Lp = serde_json::from_str(lp)?;
            let feats: super::Features = serde_json::from_str(sidecar)?;
            let opts: super::Opts = serde_json::from_str(opts)?;
            Ok(Session(super::Session::new(&lp, feats, opts)))
        }
        pub fn step(&mut self) -> String { js(&self.0.step()) }
        pub fn resume(&mut self) -> String { js(&self.0.resume()) }
        pub fn exclude(&mut self, tau: &[f64]) { self.0.exclude(tau) }
        pub fn set_d(&mut self, d: f64) { self.0.set_d(d) }
    }
}
