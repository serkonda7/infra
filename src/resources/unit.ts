import type { Executor, Executors, ResourceBase, ResourceType, Result, Scope } from "../types.ts";
import { errMsg, lines } from "./util.ts";

export interface UnitSpec extends ResourceBase {
  name: string;
  /** systemd --user unit. */
  user: boolean;
  /** Desired enablement; unmanaged when undefined. */
  enabled?: boolean;
  /** Desired running state; unmanaged when undefined. */
  started?: boolean;
  /** Resource IDs (unit files) that require a daemon-reload before this unit is touched. */
  reloadOn?: string[];
  scope: Scope;
}

export interface UnitLive {
  load: string;
  /** UnitFileState: enabled, disabled, static, masked, … */
  state: string;
  /** ActiveState: active, inactive, failed, … */
  active: string;
}

export interface UnitMeta {
  /** rig enabled it, so it disables it again once undeclared. */
  enabled?: boolean;
  /** rig started it, so it stops it again once undeclared. */
  started?: boolean;
}

const ENABLED = new Set(["enabled", "enabled-runtime", "linked", "linked-runtime", "alias"]);
/** States where enable/disable is meaningless (no [Install] section, generated, …). */
const FIXED = new Set(["static", "indirect", "generated", "transient"]);
const RUNNING = new Set(["active", "reloading", "activating"]);

const parse = (id: string) => {
  const rest = id.slice("unit:".length);
  const i = rest.indexOf(":");
  return { user: rest.slice(0, i) === "user", name: rest.slice(i + 1) };
};

async function systemctl(x: Executor, user: boolean, args: string[], verbose = false) {
  return x.run(["systemctl", ...(user ? ["--user"] : []), ...args], { stream: verbose, env: { LC_ALL: "C" } });
}

const exOf = (x: Executors, user: boolean) => (user ? x.user : x.system);

/** What has to happen to reach the spec from the live state. */
function steps(spec: UnitSpec, live: UnitLive) {
  const out: ("enable" | "disable" | "start" | "stop")[] = [];
  const isEnabled = ENABLED.has(live.state);
  if (!FIXED.has(live.state)) {
    if (spec.enabled === true && !isEnabled) out.push("enable");
    if (spec.enabled === false && isEnabled) out.push("disable");
  }
  const running = RUNNING.has(live.active);
  if (spec.started === true && !running) out.push("start");
  if (spec.started === false && running) out.push("stop");
  return out;
}

export const unitType: ResourceType<UnitSpec, UnitLive, UnitMeta> = {
  kind: "unit",
  label: "services",
  order: 50,
  afterPackages: true,
  scope: (s) => s.scope,
  id: (s) => `unit:${s.user ? "user" : "system"}:${s.name}`,
  display: (id) => {
    const { user, name } = parse(id);
    return user ? `${name} (user)` : name;
  },
  equal: (a, b) => a.enabled === b.enabled && a.started === b.started,
  edges: (s) => s.reloadOn ?? [],

  async read(items, x) {
    const out = new Map<string, UnitLive | null>();
    for (const user of [false, true]) {
      const group = items.filter((i) => parse(i.id).user === user);
      if (!group.length) continue;
      // Unit state is world-readable: always query as the user, even for system units.
      const r = await systemctl(x.user, user, ["show", "--property=LoadState,UnitFileState,ActiveState", "--", ...group.map((i) => parse(i.id).name)]);
      const blocks = r.stdout.trim().split(/\n\s*\n/);
      group.forEach(({ id }, n) => {
        const kv = Object.fromEntries(
          (blocks[n] ?? "")
            .split("\n")
            .map((l) => l.split("="))
            .map(([k, ...v]) => [k!.trim(), v.join("=").trim()]),
        );
        const load = kv.LoadState || "not-found";
        out.set(id, load === "not-found" ? null : { load, state: kv.UnitFileState ?? "", active: kv.ActiveState ?? "" });
      });
    }
    return out;
  },

  diff(spec, live, prev) {
    if (!live) {
      const want = [spec.enabled && "enable", spec.started && "start"].filter(Boolean).join(", ");
      return { op: "change", action: "create", note: `${want || "manage"}; unit not installed yet` };
    }
    if (live.state === "masked") return { op: "blocked", reason: "unit is masked (systemctl unmask it first)" };
    const s = steps(spec, live);
    if (!s.length) return { op: "noop", meta: prev ?? {} };
    return { op: "change", action: "update", note: s.join(", ") };
  },

  async apply(changes, x, ctx) {
    const results: Result<UnitMeta>[] = [];
    // Unit files written earlier in this run: reload once per manager before touching units.
    for (const user of [false, true]) {
      const needs = changes.some((c) => c.spec.user === user && c.spec.reloadOn?.some((id) => ctx.changed.has(id)));
      if (needs) await systemctl(exOf(x, user), user, ["daemon-reload"]);
    }
    for (const c of changes) {
      const { spec } = c;
      const ex = exOf(x, spec.user);
      try {
        let live = c.live;
        if (!live) {
          const r = await systemctl(x.user, spec.user, ["show", "--property=LoadState,UnitFileState,ActiveState", "--", spec.name]);
          const kv = Object.fromEntries(lines(r.stdout).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
          if (!kv.LoadState || kv.LoadState === "not-found") throw new Error(`unit ${spec.name} not found`);
          live = { load: kv.LoadState, state: kv.UnitFileState ?? "", active: kv.ActiveState ?? "" };
        }
        const meta: UnitMeta = { ...c.prevMeta };
        for (const step of steps(spec, live)) {
          const r = await systemctl(ex, spec.user, [step, "--", spec.name], ctx.verbose);
          if (r.code !== 0) throw new Error(`systemctl ${step} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
          if (step === "enable") meta.enabled = true;
          if (step === "start") meta.started = true;
          if (step === "disable") delete meta.enabled;
          if (step === "stop") delete meta.started;
        }
        results.push({ id: c.id, ok: true, meta });
      } catch (e) {
        results.push({ id: c.id, ok: false, error: errMsg(e) });
      }
    }
    return results;
  },

  planDestroy(_id, meta, live) {
    if (!live) return { op: "forget", note: "unit no longer installed" };
    const undo = [meta.enabled && ENABLED.has(live.state) && "disable", meta.started && RUNNING.has(live.active) && "stop"].filter(Boolean);
    if (!undo.length) return { op: "forget", note: "state before rig kept" };
    return { op: "destroy", note: undo.join(", ") };
  },

  async destroy(items, x, ctx) {
    const results: Result<null>[] = [];
    for (const { id, meta } of items) {
      const { user, name } = parse(id);
      const ex = exOf(x, user);
      const errs: string[] = [];
      if (meta.enabled) {
        const r = await systemctl(ex, user, ["disable", "--", name], ctx.verbose);
        if (r.code !== 0) errs.push(`disable: ${r.stderr.trim()}`);
      }
      if (meta.started) {
        const r = await systemctl(ex, user, ["stop", "--", name], ctx.verbose);
        if (r.code !== 0) errs.push(`stop: ${r.stderr.trim()}`);
      }
      results.push(errs.length ? { id, ok: false, error: errs.join("; ") } : { id, ok: true, meta: null });
    }
    return results;
  },
};
