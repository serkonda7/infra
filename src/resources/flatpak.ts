// Flatpak apps, installed system-wide from a remote (Flathub by default).
// Same ownership model as the distro packages: rig only removes what it
// installed, and apps that were there before it are adopted and kept
// (unless listed in packages.remove).

import type { Executor, ResourceBase, ResourceType, Result } from "../types.ts";
import { lines } from "./util.ts";
import { tail } from "./pacman.ts";

export interface FlatpakSpec extends ResourceBase {
  app: string;
  remote: string;
  /** Added with `flatpak remote-add --if-not-exists` before installing. */
  url?: string;
}

export interface FlatpakLive {
  origin: string;
}

export interface FlatpakMeta {
  /** rig installed it, so it uninstalls it once undeclared. */
  installed?: boolean;
  /** Already installed before rig: kept. */
  adopted?: boolean;
}

export const FLATHUB = { name: "flathub", url: "https://dl.flathub.org/repo/flathub.flatpakrepo" };

/** Reverse-DNS application IDs: org.mozilla.firefox, com.valvesoftware.Steam, … */
export const isAppId = (s: string) => /^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*){2,}$/.test(s);

const prefix = "pkg:flatpak:";
const name = (id: string) => id.slice(prefix.length);

function flatpak(x: Executor, args: string[], verbose = false) {
  return x.run(["flatpak", ...args], { stream: verbose, env: { LC_ALL: "C" } });
}

export const flatpakType: ResourceType<FlatpakSpec, FlatpakLive, FlatpakMeta> = {
  kind: "pkg:flatpak",
  label: "packages (flatpak)",
  order: 2,
  scope: () => "system",
  id: (s) => prefix + s.app,
  display: (id) => name(id),
  equal: (a, b) => a.remote === b.remote && a.url === b.url,

  async read(items, x) {
    const out = new Map<string, FlatpakLive | null>();
    if (!items.length) return out;
    // Before the flatpak package is installed this fails: nothing is installed then.
    const r = await flatpak(x.user, ["list", "--app", "--system", "--columns=application,origin"]).catch(() => ({ code: 127, stdout: "", stderr: "" }));
    const installed = new Map(
      (r.code === 0 ? lines(r.stdout) : []).map((l) => {
        const [app, origin] = l.split("\t");
        return [app!, origin ?? ""] as const;
      }),
    );
    for (const { id } of items) {
      const origin = installed.get(name(id));
      out.set(id, origin === undefined ? null : { origin });
    }
    return out;
  },

  diff(spec, live, prev) {
    if (!live) return { op: "change", action: "create", ...(spec.remote !== FLATHUB.name ? { note: `from ${spec.remote}` } : {}) };
    return { op: "noop", meta: prev ?? { adopted: true } };
  },

  async apply(changes, x, ctx) {
    const results: Result<FlatpakMeta>[] = [];
    const byRemote = new Map<string, typeof changes>();
    for (const c of changes) (byRemote.get(c.spec.remote) ?? byRemote.set(c.spec.remote, []).get(c.spec.remote)!).push(c);
    for (const [remote, list] of byRemote) {
      const fail = (error: string) => list.forEach((c) => results.push({ id: c.id, ok: false, error }));
      const url = list.find((c) => c.spec.url)?.spec.url ?? (remote === FLATHUB.name ? FLATHUB.url : undefined);
      if (url) {
        const r = await flatpak(x.system, ["remote-add", "--system", "--if-not-exists", remote, url], ctx.verbose);
        if (r.code !== 0) {
          fail(`flatpak remote-add ${remote} failed: ${tail(r.stderr) || `exit ${r.code}`}`);
          continue;
        }
      }
      // One transaction per remote, like pacman.
      const r = await flatpak(x.system, ["install", "--system", "-y", "--noninteractive", remote, ...list.map((c) => c.spec.app)], ctx.verbose);
      if (r.code !== 0) fail(`install failed: ${tail(r.stderr) || `exit ${r.code}`}`);
      else for (const c of list) results.push({ id: c.id, ok: true, meta: { installed: true } });
    }
    return results;
  },

  planDestroy(_id, meta, live) {
    if (!live) return { op: "forget", note: "already removed" };
    if (!meta.installed) return { op: "forget", note: "installed before rig; kept" };
    return { op: "destroy" };
  },

  async destroy(items, x, ctx) {
    const results: Result<null>[] = [];
    const uninstall = (ids: string[]) => flatpak(x.system, ["uninstall", "--system", "-y", "--noninteractive", ...ids.map(name)], ctx.verbose);
    const r = await uninstall(items.map((i) => i.id));
    if (r.code === 0) for (const { id } of items) results.push({ id, ok: true, meta: null });
    else {
      // Retry one by one so one stuck app doesn't keep the others.
      for (const { id } of items) {
        const one = await uninstall([id]);
        results.push(one.code === 0 ? { id, ok: true, meta: null } : { id, ok: false, error: tail(one.stderr) || `exit ${one.code}` });
      }
    }
    // Runtimes only the removed apps needed (best effort).
    if (results.some((r) => r.ok)) await flatpak(x.system, ["uninstall", "--system", "-y", "--noninteractive", "--unused"], ctx.verbose);
    return results;
  },

  // Exact mode never prunes apps; only those listed in packages.remove.
  async extraneous({ declared, keep, only }, x) {
    if (!only?.length) return [];
    const r = await flatpak(x.user, ["list", "--app", "--system", "--columns=application"]).catch(() => ({ code: 127, stdout: "", stderr: "" }));
    const kept = keep.map((k) => new Bun.Glob(k));
    const wanted = only.map((k) => new Bun.Glob(k));
    return (r.code === 0 ? lines(r.stdout) : [])
      .map((l) => l.split("\t")[0]!)
      .filter((n) => !declared.has(prefix + n) && !kept.some((g) => g.match(n)) && wanted.some((g) => g.match(n)))
      .map((n) => ({ id: prefix + n, scope: "system" as const, meta: { installed: true } satisfies FlatpakMeta, display: n }));
  },
};
