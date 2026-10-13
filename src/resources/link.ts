import type { ResourceBase, ResourceType, Scope, StatType } from "../types.ts";
import { pick } from "../types.ts";
import { errMsg, idPath, pretty, tilde } from "./util.ts";

export interface LinkSpec extends ResourceBase {
  path: string;
  /** Absolute path the link points to (inside the repo). */
  target: string;
  scope: Scope;
}

export interface LinkLive {
  type: StatType;
  target?: string;
}

export interface LinkMeta {
  target: string;
  /** Previous symlink target we replaced; restored on destroy. */
  replaced?: string;
  /** Where a pre-existing file/dir was moved aside (--force); moved back on destroy. */
  displaced?: string;
}

export const linkType: ResourceType<LinkSpec, LinkLive, LinkMeta> = {
  kind: "link",
  label: "links",
  order: 30,
  scope: (s) => s.scope,
  id: (s) => `link:${s.path}`,
  display: (id, s, { home, repo }) => {
    const p = tilde(idPath(id), home);
    return s ? `${p} → ${pretty(s.target, home, repo)}` : p;
  },
  equal: (a, b) => a.target === b.target,

  async read(items, x) {
    const out = new Map<string, LinkLive | null>();
    await Promise.all(
      items.map(async ({ id, scope }) => {
        const ex = pick(x, scope);
        const st = await ex.lstat(idPath(id));
        if (!st) return out.set(id, null);
        out.set(id, st.type === "symlink" ? { type: "symlink", target: (await ex.readlink(idPath(id))) ?? "" } : { type: st.type });
      }),
    );
    return out;
  },

  diff(spec, live, prev, ctx) {
    if (!live) return { op: "change", action: "create" };
    if (live.type === "symlink") {
      if (live.target === spec.target) return { op: "noop", meta: prev ? { ...prev, target: spec.target } : { target: spec.target } };
      return { op: "change", action: "update", note: `currently → ${tilde(live.target!, ctx.home)}` };
    }
    const p = tilde(spec.path, ctx.home);
    if (!ctx.force)
      return { op: "blocked", reason: `a ${live.type} exists here — \`rig adopt ${p}\` to move it into the repo, or --force to move it aside` };
    return { op: "change", action: "update", note: `existing ${live.type} moved to ${p}.rig-orig` };
  },

  async apply(changes, x) {
    return Promise.all(
      changes.map(async (c) => {
        const { spec, live, prevMeta } = c;
        const ex = pick(x, spec.scope);
        try {
          const meta: LinkMeta = { target: spec.target };
          if (prevMeta?.replaced) meta.replaced = prevMeta.replaced;
          if (prevMeta?.displaced) meta.displaced = prevMeta.displaced;
          if (live?.type === "symlink" && !prevMeta && live.target) meta.replaced = live.target;
          if (live && live.type !== "symlink") {
            let aside = `${spec.path}.rig-orig`;
            if (await ex.lstat(aside)) aside += `-${Date.now()}`;
            await ex.rename(spec.path, aside);
            meta.displaced = aside;
          }
          await ex.symlink(spec.target, spec.path);
          return { id: c.id, ok: true as const, meta };
        } catch (e) {
          return { id: c.id, ok: false as const, error: errMsg(e) };
        }
      }),
    );
  },

  planDestroy(_id, meta, live) {
    if (!live) return { op: "forget", note: "already gone" };
    if (live.type !== "symlink" || live.target !== meta.target) return { op: "forget", note: "no longer points into the repo; left alone" };
    if (meta.displaced) return { op: "destroy", note: "restore moved-aside original" };
    if (meta.replaced) return { op: "destroy", note: "restore previous link" };
    return { op: "destroy" };
  },

  async destroy(items, x) {
    const results = [];
    for (const { id, scope, meta } of items) {
      const ex = pick(x, scope);
      const path = idPath(id);
      try {
        await ex.unlink(path);
        if (meta.displaced && (await ex.lstat(meta.displaced))) await ex.rename(meta.displaced, path);
        else if (meta.replaced) await ex.symlink(meta.replaced, path);
        results.push({ id, ok: true as const, meta: null });
      } catch (e) {
        results.push({ id, ok: false as const, error: errMsg(e) });
      }
    }
    return results;
  },
};
