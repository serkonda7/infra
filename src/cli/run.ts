// `rig plan` / `rig apply` / `rig dot` against the machine rig runs on —
// either locally, or as the target half of a remote apply.

import { checkOffline, closeExecutors, gitCommit, plan as makePlan, prepare, type EngineOptions } from "../engine.ts";
import { planView, eventView } from "../plan/format.ts";
import { applyPlan, type ApplyOutcome } from "../apply/apply.ts";
import { DeadMan, isRisky } from "../apply/deadman.ts";
import { snapshotter, type Snapshotter } from "../apply/snapshot.ts";
import { spawn } from "../exec/local.ts";
import { gatherFacts } from "../facts/index.ts";
import { StateStore, defaultStateDir } from "../state/state.ts";
import { errMsg } from "../resources/util.ts";
import type { Facts } from "../types.ts";
import type { Plan } from "../plan/plan.ts";
import type { Session } from "./session.ts";
import { parseFixture } from "../facts/fixture.ts";
import { c, out } from "./ui.ts";
import { relative } from "node:path";

export interface RunOptions {
  engine: EngineOptions;
  userOnly?: boolean;
  upgrade?: boolean;
  noSnapshot?: boolean;
  verbose?: boolean;
  /** Commit to record; looked up in the repo when undefined. */
  commit?: string | null;
  /** Target of a remote run: wrap connection-critical changes in the dead-man's switch. */
  guardConnection?: boolean;
  /** rig rollback: the generation whose config this is. */
  rollbackOf?: number;
}

/** Exit code: 2 if there are changes, 1 if something is blocked, else 0. */
export async function runPlan(o: RunOptions, s: Session): Promise<number> {
  const p = await prepare(o.engine);
  try {
    const view = planView(await makePlan(p, o.engine));
    s.plan(view);
    return view.summary.actionable ? 2 : view.summary.blocked ? 1 : 0;
  } finally {
    await closeExecutors(p.x);
  }
}

/** Full system upgrade before applying, so installs never produce a partial upgrade. */
async function upgrade(facts: Facts, s: Session): Promise<boolean> {
  const steps =
    facts.os.family === "debian"
      ? [["apt-get", "update"], ["apt-get", "-y", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold", "upgrade"]]
      : [["pacman", "-Syu", "--noconfirm"]];
  for (const argv of steps) {
    s.info(`${argv.join(" ")} …`);
    const r = await spawn(["sudo", "--", ...argv], { stream: true, env: { DEBIAN_FRONTEND: "noninteractive" } });
    if (r.code !== 0) return false;
  }
  return true;
}

export async function runApply(o: RunOptions, s: Session): Promise<number> {
  const facts = o.engine.facts ?? gatherFacts();
  const state = new StateStore(o.engine.stateDir ?? defaultStateDir(facts.user.home));
  const unlock = state.lock();
  let x: Awaited<ReturnType<typeof prepare>>["x"] | undefined;
  try {
    if (o.upgrade && !o.userOnly) {
      if (!(await s.sudo())) return 1;
      if (!(await upgrade(facts, s))) return s.warn("system upgrade failed"), 1;
    }
    const p = await prepare({ ...o.engine, facts });
    x = p.x;
    const plan = await makePlan(p, o.engine);
    const view = planView(plan);
    s.plan(view);

    if (view.summary.actionable && !(await s.confirm("Apply these changes?"))) return 1;
    const needsRoot = view.summary.actionable && view.needsRoot;
    if (needsRoot && !(await s.sudo())) return 1;
    if (view.summary.actionable) s.info("");

    // Snapshot before touching the system, so a broken boot can be rolled back from the boot menu.
    let snap: Snapshotter | null = null;
    let snapshot: string | undefined;
    const description = `rig apply ${p.hostName}`;
    if (needsRoot && !o.noSnapshot) {
      try {
        snap = await snapshotter(p.hostDef.snapshots ?? p.config.defaults?.snapshots ?? "auto", facts, p.x.system);
        snapshot = await snap?.pre(description);
        if (snapshot) s.info(`snapshot ${snapshot}`);
      } catch (e) {
        s.warn(`${errMsg(e)}\nnot applying; pass --no-snapshot to apply without one`);
        return 1;
      }
    }

    const seconds = p.hostDef.connect?.deadman ?? 120;
    const deadman = needsRoot && o.guardConnection && seconds > 0 ? new DeadMan(p.x.system, seconds) : null;
    const outcome = await applyPlan(plan, {
      x: p.x,
      objects: p.state.objects(),
      repo: p.repo,
      commit: o.commit !== undefined ? o.commit : await gitCommit(p.repo),
      force: o.engine.force,
      verbose: o.verbose,
      onEvent: (e) => s.event(eventView(e)),
      guard: deadman
        ? {
            risky: isRisky,
            arm: async (items) => {
              await deadman.arm(items);
              s.info(`dead-man's switch armed: ${items.length} connection-critical change(s) revert in ${deadman.seconds}s unless a fresh SSH login works`);
            },
          }
        : undefined,
    });
    if (deadman?.isArmed) await settleDeadman(deadman, plan, outcome, s);
    if (snapshot) outcome.generation.snapshot = snapshot;
    if (o.rollbackOf) outcome.generation.rollbackOf = o.rollbackOf;
    try {
      await snap?.post(description);
    } catch (e) {
      s.warn(errMsg(e));
    }
    if (outcome.dirty) await p.state.write(outcome.generation);

    s.done({
      generation: outcome.generation.id,
      status: outcome.generation.status,
      dirty: outcome.dirty,
      failed: outcome.failed,
      actionable: view.summary.actionable,
      events: outcome.events.map(eventView),
    });
    return outcome.failed || view.summary.blocked ? 1 : 0;
  } finally {
    if (x) await closeExecutors(x);
    unlock();
  }
}

/** Ask the controller for a fresh login; keep the changes if it works, revert them now if not. */
async function settleDeadman(deadman: DeadMan, plan: Plan, outcome: ApplyOutcome, s: Session) {
  let ok = false;
  try {
    ok = s.verify ? await s.verify() : true;
  } catch (e) {
    s.warn(`could not verify the connection: ${errMsg(e)}`);
  }
  if (ok) {
    try {
      await deadman.disarm();
      s.info("fresh SSH login works · dead-man's switch disarmed");
    } catch (e) {
      s.warn(`${errMsg(e)} — the changes will be reverted when it fires`);
    }
    return;
  }
  try {
    await deadman.fire();
    s.warn(`fresh SSH login failed: reverted ${outcome.guarded.length} connection-critical change(s)`);
  } catch (e) {
    s.warn(`fresh SSH login failed and reverting failed too: ${errMsg(e)}`);
  }
  // The reverted resources are back to what the previous generation recorded.
  const g = outcome.generation;
  for (const id of outcome.guarded) {
    const prev = plan.prev?.resources[id];
    if (prev) g.resources[id] = prev;
    else delete g.resources[id];
  }
  g.status = "partial";
  outcome.failed += outcome.guarded.length;
  if (!outcome.dirty) {
    outcome.dirty = true;
    g.id = (plan.prev?.id ?? 0) + 1;
  }
}

/** `rig plan --offline --facts <file>`: evaluate and validate without the machine. Problems throw ConfigError. */
export async function runOffline(engine: EngineOptions, fixturePath: string, opts: { json?: boolean; verbose?: boolean } = {}): Promise<number> {
  const file = Bun.file(fixturePath);
  if (!(await file.exists())) throw new Error(`no facts file ${fixturePath} (create one on the host with \`rig facts --save\`)`);
  const fixture = parseFixture(await file.text(), fixturePath);
  const r = await checkOffline({ ...engine, fixture });
  const decls = r.order.map((id) => r.graph.decls.get(id)!);
  const paths = { home: r.facts.user.home, repo: r.repo };
  if (opts.json) {
    const resources = decls.map((d) => ({ id: d.id, scope: d.scope, display: d.type.display(d.id, d.spec, paths), declaredBy: d.provenance }));
    out(JSON.stringify({ host: r.hostName, os: r.facts.os.name, ok: true, warnings: r.warnings, resources }, null, 2));
    return 0;
  }
  out(`${c.bold("host")} ${r.hostName} · ${r.facts.os.name} · offline, facts from ${relative(process.cwd(), fixturePath)}`);
  const sections = new Map<string, typeof decls>();
  for (const d of [...decls].sort((a, b) => a.type.order - b.type.order)) (sections.get(d.type.label) ?? sections.set(d.type.label, []).get(d.type.label)!).push(d);
  out();
  for (const [label, list] of sections) {
    out(`  ${label.padEnd(22)} ${list.length}`);
    if (opts.verbose) for (const d of list) out(c.dim(`      ${d.type.display(d.id, d.spec, paths)}`));
  }
  if (r.warnings.length) {
    out();
    out(c.yellow("warnings"));
    for (const w of r.warnings) out(`  ${c.yellow("⚠")} ${w}`);
  }
  const checked = fixture.packages ? `package names checked against ${fixture.packages.backend} lists from ${fixture.packages.at.slice(0, 10)}` : "package names not checked";
  out();
  out(c.green(`OK · ${decls.length} resources evaluate and validate`) + c.dim(` (${checked})`));
  return 0;
}
