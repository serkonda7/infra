import type { ResourceBase, ResourceType, Result, Scope } from "../types.ts";
import { pick } from "../types.ts";
import { errMsg } from "./util.ts";

/**
 * Ansible-style handler: runs once at the end of an apply, in declaration
 * order, if any of the resources it subscribes to changed.
 */
export interface TriggerSpec extends ResourceBase {
  cmd: string;
  on: string[];
  scope: Scope;
  cwd: string;
}

const tail = (s: string) => s.trim().split("\n").slice(-6).join("\n");

export const triggerType: ResourceType<TriggerSpec, null, {}> = {
  kind: "trigger",
  label: "triggers",
  order: 90,
  deferred: true,
  scope: (s) => s.scope,
  id: (s) => `trigger:${Bun.hash.xxHash3(`${s.scope}\0${s.cmd}`).toString(16).padStart(16, "0").slice(0, 12)}`,
  display: (id, s) => (s ? (s.scope === "system" ? "# " : "$ ") + s.cmd : id),
  equal: () => true,
  // Several modules may subscribe the same command to different resources.
  merge: (a, b) => ({ ...a, on: [...new Set([...a.on, ...b.on])] }),
  edges: (s) => s.on,

  async read(items) {
    return new Map(items.map((i) => [i.id, null]));
  },

  diff(spec, _live, _prev, ctx) {
    const by = spec.on.filter((id) => ctx.changed.has(id));
    if (!by.length) return { op: "noop", meta: {} };
    return { op: "change", action: "run", note: `on change of ${by.length > 2 ? `${by.slice(0, 2).join(", ")} +${by.length - 2}` : by.join(", ")}` };
  },

  async apply(changes, x, ctx) {
    const results: Result<{}>[] = [];
    for (const c of changes) {
      const { spec } = c;
      if (!spec.on.some((id) => ctx.changed.has(id))) {
        results.push({ id: c.id, ok: true, meta: {}, note: "skipped: nothing it watches changed" });
        continue;
      }
      try {
        const r = await pick(x, spec.scope).run(["sh", "-c", spec.cmd], { cwd: spec.cwd, stream: ctx.verbose });
        results.push(r.code === 0 ? { id: c.id, ok: true, meta: {} } : { id: c.id, ok: false, error: `exit ${r.code}${r.stderr ? `: ${tail(r.stderr)}` : ""}` });
      } catch (e) {
        results.push({ id: c.id, ok: false, error: errMsg(e) });
      }
    }
    return results;
  },
};
