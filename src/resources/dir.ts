import type { ResourceBase, ResourceType, Scope, StatType } from "../types.ts";
import { pick } from "../types.ts";
import { errMsg, idPath, octal, tilde } from "./util.ts";

export interface DirSpec extends ResourceBase {
  path: string;
  mode?: number;
  scope: Scope;
}

export interface DirLive {
  type: StatType;
  mode: number;
}

export interface DirMeta {
  /** Existed before rig declared it: never removed. */
  preexisting?: boolean;
}

export const dirType: ResourceType<DirSpec, DirLive, DirMeta> = {
  kind: "dir",
  label: "directories",
  order: 10,
  scope: (s) => s.scope,
  id: (s) => `dir:${s.path}`,
  display: (id, _s, { home }) => tilde(idPath(id), home) + "/",
  equal: (a, b) => a.mode === b.mode,

  async read(items, x) {
    const out = new Map<string, DirLive | null>();
    await Promise.all(items.map(async ({ id, scope }) => out.set(id, await pick(x, scope).lstat(idPath(id)))));
    return out;
  },

  diff(spec, live, prev) {
    if (!live) return { op: "change", action: "create" };
    if (live.type !== "dir") return { op: "blocked", reason: `a ${live.type} exists at this path` };
    if (spec.mode !== undefined && spec.mode !== live.mode)
      return { op: "change", action: "update", note: `mode ${octal(live.mode)} → ${octal(spec.mode)}` };
    return { op: "noop", meta: prev ?? { preexisting: true } };
  },

  async apply(changes, x) {
    const results = [];
    // Sequential, shallowest first, so nested dirs get their own modes.
    for (const c of [...changes].sort((a, b) => a.spec.path.length - b.spec.path.length)) {
      const ex = pick(x, c.spec.scope);
      try {
        if (c.live) await ex.chmod(c.spec.path, c.spec.mode!);
        else await ex.mkdirp(c.spec.path, c.spec.mode);
        results.push({ id: c.id, ok: true as const, meta: c.prevMeta ?? {} });
      } catch (e) {
        results.push({ id: c.id, ok: false as const, error: errMsg(e) });
      }
    }
    return results;
  },

  planDestroy(_id, meta, live) {
    if (!live || live.type !== "dir") return { op: "forget" };
    if (meta.preexisting) return { op: "forget", note: "existed before rig; kept" };
    return { op: "destroy", note: "if empty" };
  },

  async destroy(items, x) {
    const results = [];
    // Deepest first so nested managed dirs empty out before their parents.
    for (const { id, scope } of [...items].sort((a, b) => b.id.length - a.id.length)) {
      try {
        const removed = await pick(x, scope).rmdir(idPath(id));
        results.push({ id, ok: true as const, meta: null, note: removed ? undefined : "not empty; left in place" });
      } catch (e) {
        results.push({ id, ok: false as const, error: errMsg(e) });
      }
    }
    return results;
  },
};
