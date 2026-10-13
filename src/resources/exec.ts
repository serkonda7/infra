import type { ResourceBase, ResourceType, Result, Scope } from "../types.ts";
import { pick } from "../types.ts";
import { errMsg } from "./util.ts";

export interface ExecSpec extends ResourceBase {
  cmd: string;
  /** Skip if this shell command exits 0. */
  unless?: string;
  /** Skip if this path exists. */
  creates?: string;
  /** Only run when one of these resource IDs changed in this apply. */
  onChange?: string[];
  /** Command run when the resource is removed from config. */
  undo?: string;
  scope: Scope;
  cwd: string;
}

export interface ExecLive {
  needed: boolean;
}

export interface ExecMeta {
  undo?: string;
  cwd?: string;
}

const tail = (s: string) => s.trim().split("\n").slice(-6).join("\n");

export const execType: ResourceType<ExecSpec, ExecLive, ExecMeta> = {
  kind: "exec",
  label: "commands",
  order: 40,
  scope: (s) => s.scope,
  id: (s) => `exec:${Bun.hash.xxHash3(`${s.scope}\0${s.cmd}`).toString(16).padStart(16, "0").slice(0, 12)}`,
  display: (id, s) => (s ? (s.scope === "system" ? "# " : "$ ") + s.cmd : id),
  equal: (a, b) =>
    a.unless === b.unless && a.creates === b.creates && a.undo === b.undo && String(a.onChange) === String(b.onChange),
  edges: (s) => s.onChange ?? [],

  async read(items, x) {
    const out = new Map<string, ExecLive | null>();
    for (const { id, spec } of items) {
      if (!spec) {
        out.set(id, null);
        continue;
      }
      const ex = pick(x, spec.scope);
      let needed = true;
      if (spec.creates && (await ex.lstat(spec.creates))) needed = false;
      if (needed && spec.unless) needed = (await ex.run(["sh", "-c", spec.unless], { cwd: spec.cwd })).code !== 0;
      out.set(id, { needed });
    }
    return out;
  },

  diff(spec, live, _prev, ctx) {
    const meta: ExecMeta = spec.undo ? { undo: spec.undo, cwd: spec.cwd } : {};
    if (spec.onChange?.length) {
      const by = spec.onChange.filter((id) => ctx.changed.has(id));
      if (!by.length || !live?.needed) return { op: "noop", meta };
      return { op: "change", action: "run", note: `on change of ${by.join(", ")}` };
    }
    if (live && !live.needed) return { op: "noop", meta };
    return { op: "change", action: "run", note: spec.unless || spec.creates ? undefined : "unguarded" };
  },

  async apply(changes, x, ctx) {
    const results: Result<ExecMeta>[] = [];
    for (const c of changes) {
      const { spec } = c;
      if (spec.onChange?.length && !spec.onChange.some((id) => ctx.changed.has(id))) {
        results.push({ id: c.id, ok: true, meta: c.prevMeta ?? {}, note: "skipped: trigger did not change" });
        continue;
      }
      try {
        const r = await pick(x, spec.scope).run(["sh", "-c", spec.cmd], { cwd: spec.cwd, stream: ctx.verbose });
        results.push(
          r.code === 0
            ? { id: c.id, ok: true, meta: spec.undo ? { undo: spec.undo, cwd: spec.cwd } : {} }
            : { id: c.id, ok: false, error: `exit ${r.code}${r.stderr ? `: ${tail(r.stderr)}` : ""}` },
        );
      } catch (e) {
        results.push({ id: c.id, ok: false, error: errMsg(e) });
      }
    }
    return results;
  },

  planDestroy(_id, meta) {
    return meta.undo ? { op: "destroy", note: `undo: ${meta.undo}` } : { op: "forget" };
  },

  async destroy(items, x, ctx) {
    const results: Result<null>[] = [];
    for (const { id, scope, meta } of items) {
      const r = await pick(x, scope).run(["sh", "-c", meta.undo!], { cwd: meta.cwd, stream: ctx.verbose });
      results.push(r.code === 0 ? { id, ok: true, meta: null } : { id, ok: false, error: `undo exit ${r.code}: ${tail(r.stderr)}` });
    }
    return results;
  },
};
