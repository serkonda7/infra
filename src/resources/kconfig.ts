// Single keys in KDE config files (kwinrc, kdeglobals, …). Plasma rewrites
// these files itself, so rig owns individual keys, never the whole file:
// reads parse the INI directly (one read per file), writes go through
// kwriteconfig6 so running apps are notified.

import type { ResourceBase, ResourceType, Result, Scope } from "../types.ts";
import { pick } from "../types.ts";
import { errMsg, tilde } from "./util.ts";
import { tail } from "./pacman.ts";

export interface KconfigSpec extends ResourceBase {
  path: string;
  /** Nested groups: [Containments][1][General] is ["Containments", "1", "General"]. */
  group: string[];
  key: string;
  value: string;
  /** Booleans compare loosely (true/on/yes/1) and are written with --type bool. */
  bool?: boolean;
  scope: Scope;
}

export interface KconfigLive {
  /** null: the key (or the file) doesn't exist. */
  value: string | null;
}

export interface KconfigMeta {
  path: string;
  group: string[];
  key: string;
  /** What rig wrote. */
  value: string;
  /** The value before rig took over; restored on destroy (null: the key is deleted). */
  previous: string | null;
}

export const KWRITECONFIG = "kwriteconfig6";

const dec = new TextDecoder();

function unescape(v: string): string {
  return v.replace(/\\(s|t|n|r|\\|x[0-9a-fA-F]{2})/g, (_, c: string) =>
    c === "s" ? " " : c === "t" ? "\t" : c === "n" ? "\n" : c === "r" ? "\r" : c === "\\" ? "\\" : String.fromCharCode(parseInt(c.slice(1), 16)),
  );
}

const groupKey = (group: string[], key: string) => `${group.join("\0")}\0\0${key}`;

/** Every unlocalized key of a KConfig file, by group path + key. Later entries win, like KConfig. */
export function parseKconfig(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let group: string[] | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[")) {
      const m = line.match(/^\[(.*)\]$/);
      group = m ? m[1]!.split("][") : null;
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0 || !group) continue;
    // Flags like [$i] / [$e] don't change the key; a locale suffix ([de]) makes it another key.
    const name = line.slice(0, eq).trim().replace(/(\[\$[^\]]*\])+$/, "");
    if (name.includes("[")) continue;
    out.set(groupKey(group, name), unescape(line.slice(eq + 1).trim()));
  }
  return out;
}

const TRUE = new Set(["true", "on", "yes", "1"]);
const FALSE = new Set(["false", "off", "no", "0"]);
const normalize = (v: string, bool?: boolean) => (bool ? (TRUE.has(v.toLowerCase()) ? "true" : FALSE.has(v.toLowerCase()) ? "false" : v) : v);

const short = (v: string | null) => (v === null ? "unset" : v.length > 40 ? JSON.stringify(v.slice(0, 37) + "…") : JSON.stringify(v));

export const kconfigId = (path: string, group: string[], key: string) => `kcfg:${path}:${group.join("][")}.${key}`;

export const kconfigType: ResourceType<KconfigSpec, KconfigLive, KconfigMeta> = {
  kind: "kcfg",
  label: "KDE settings",
  order: 35,
  scope: (s) => s.scope,
  id: (s) => kconfigId(s.path, s.group, s.key),
  display: (id, s, { home }) => {
    if (!s) return id.slice("kcfg:".length);
    const file = s.path.startsWith(`${home}/.config/`) ? s.path.slice(home.length + "/.config/".length) : tilde(s.path, home);
    return `${file} [${s.group.join("][")}] ${s.key}`;
  },
  equal: (a, b) => a.value === b.value && a.bool === b.bool,

  async validate(_specs, ctx) {
    if (ctx.offline) return [];
    const r = await ctx.x.user.run(["sh", "-c", `command -v ${KWRITECONFIG}`]);
    return r.code === 0 ? [] : [`kconfig() needs ${KWRITECONFIG} (Arch: kconfig, Debian: libkf6config-bin)`];
  },

  async read(items, x) {
    const out = new Map<string, KconfigLive | null>();
    const files = new Map<string, Promise<Map<string, string>>>();
    await Promise.all(
      items.map(async ({ id, scope, spec, meta }) => {
        const where = spec ?? meta!;
        let parsed = files.get(where.path);
        if (!parsed) {
          parsed = pick(x, scope)
            .readFile(where.path)
            .then((d) => parseKconfig(d ? dec.decode(d) : ""));
          files.set(where.path, parsed);
        }
        const value = (await parsed).get(groupKey(where.group, where.key));
        out.set(id, { value: value === undefined ? null : normalize(value, spec?.bool) });
      }),
    );
    return out;
  },

  diff(spec, live, prev) {
    const current = live?.value ?? null;
    const where = { path: spec.path, group: spec.group, key: spec.key };
    if (current === spec.value) return { op: "noop", meta: prev ? { ...prev, ...where, value: spec.value } : { ...where, value: spec.value, previous: current } };
    return { op: "change", action: current === null ? "create" : "update", note: `${short(current)} → ${short(spec.value)}` };
  },

  async apply(changes, x, ctx) {
    const results: Result<KconfigMeta>[] = [];
    // Sequential: kwriteconfig6 rewrites the whole file each time.
    for (const c of changes) {
      const { spec } = c;
      try {
        const r = await pick(x, spec.scope).run(writeArgs(spec, spec.value), { stream: ctx.verbose });
        if (r.code !== 0) throw new Error(`${KWRITECONFIG} failed: ${tail(r.stderr) || `exit ${r.code}`}`);
        const previous = c.prevMeta ? c.prevMeta.previous : (c.live?.value ?? null);
        results.push({ id: c.id, ok: true, meta: { path: spec.path, group: spec.group, key: spec.key, value: spec.value, previous } });
      } catch (e) {
        results.push({ id: c.id, ok: false, error: errMsg(e) });
      }
    }
    return results;
  },

  planDestroy(_id, meta, live) {
    const current = live?.value ?? null;
    if (current !== meta.value) return { op: "forget", note: "changed since rig set it; left alone" };
    if (meta.previous === meta.value) return { op: "forget", note: "already set before rig; kept" };
    return { op: "destroy", note: meta.previous === null ? "unset" : `restore ${short(meta.previous)}` };
  },

  async destroy(items, x, ctx) {
    const results: Result<null>[] = [];
    for (const { id, scope, meta } of items) {
      const r = await pick(x, scope).run(writeArgs({ ...meta, scope }, meta.previous), { stream: ctx.verbose });
      results.push(r.code === 0 ? { id, ok: true, meta: null } : { id, ok: false, error: `${KWRITECONFIG} failed: ${tail(r.stderr) || `exit ${r.code}`}` });
    }
    return results;
  },
};

/** kwriteconfig6 argv; a null value deletes the key. */
function writeArgs(s: Pick<KconfigSpec, "path" | "group" | "key" | "bool" | "scope">, value: string | null): string[] {
  return [
    KWRITECONFIG,
    "--file",
    s.path,
    ...s.group.flatMap((g) => ["--group", g]),
    "--key",
    s.key,
    // Tell running Plasma apps to re-read (only meaningful in the user's own session).
    ...(s.scope === "user" ? ["--notify"] : []),
    ...(value === null ? ["--delete"] : [...(s.bool ? ["--type", "bool"] : []), "--", value]),
  ];
}
