// Debian packages. Same ownership model as pacman: "explicit" is apt's
// "manually installed" mark, and rig only removes what it installed.

import type { Executor, ResourceType, Result, RunResult } from "../types.ts";
import { errMsg, lines } from "./util.ts";
import { planPkgDestroy, tail, type PacmanLive, type PacmanMeta, type PacmanSpec } from "./pacman.ts";

const ENV = { DEBIAN_FRONTEND: "noninteractive", LC_ALL: "C" };
/** Keep our own copies of config files: rig writes the ones it manages after installing anyway. */
const DPKG_OPTS = ["-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold"];

/** Never pruned in exact mode, on top of priority required/important: removing them leaves a box unbootable or unreachable. */
export const APT_PROTECTED = ["linux-image-*", "linux-headers-*", "grub-*", "shim-*", "openssh-server", "sudo", "ifupdown", "systemd-sysv", "init"];

/** Resource IDs of apt sources and keyrings (written as files by pkg.repo on Debian). */
export const isAptSource = (id: string) => id.startsWith("file:") && /\/etc\/apt\/(sources\.list\.d|keyrings)\//.test(id);

const prefix = "pkg:apt:";
const name = (id: string) => id.slice(prefix.length);

export function aptGet(x: Executor, args: string[], verbose: boolean) {
  return x.run(["apt-get", "-y", ...DPKG_OPTS, ...args], { stream: verbose, env: ENV });
}

/** Installed packages from dpkg's status database. */
async function installed(x: Executor): Promise<Set<string>> {
  const r = await x.run(["dpkg-query", "-W", "-f", "${Package}\t${db:Status-Abbrev}\n"], { env: ENV });
  const out = new Set<string>();
  for (const l of lines(r.stdout)) {
    const [pkg, status] = l.split("\t");
    // "ii" installed, "hi" held; anything else (rc = removed, config left) counts as absent.
    if (pkg && /^[ih]i/.test(status ?? "")) out.add(pkg);
  }
  return out;
}

const manual = async (x: Executor) => new Set(lines((await x.run(["apt-mark", "showmanual"], { env: ENV })).stdout));

/** apt-get install, refreshing the package lists first when sources changed this run or apt can't find a package. */
async function install(names: string[], x: Executor, refresh: boolean, verbose: boolean): Promise<RunResult> {
  if (refresh) {
    const u = await aptGet(x, ["update"], verbose);
    if (u.code !== 0) return { ...u, stderr: `apt-get update failed: ${u.stderr}` };
  }
  const r = await aptGet(x, ["install", ...names], verbose);
  if (r.code === 0 || refresh || !/Unable to locate package|has no installation candidate|404\s+Not Found/.test(r.stderr)) return r;
  return install(names, x, true, verbose);
}

export const aptType: ResourceType<PacmanSpec, PacmanLive, PacmanMeta> = {
  kind: "pkg:apt",
  label: "packages (apt)",
  order: 0,
  scope: () => "system",
  id: (s) => prefix + s.name,
  display: (id) => name(id),
  equal: () => true,

  async validate(specs, ctx) {
    if (!specs.length) return [];
    if (ctx.facts.os.family !== "debian") return [`pkg:apt packages declared, but this host is ${ctx.facts.os.name}`];
    const r = await ctx.x.user.run(["apt-cache", "pkgnames"], { env: ENV });
    const known = new Set(lines(r.stdout));
    // Fresh install without package lists: nothing to check against until the first apt-get update.
    if (r.code !== 0 || !known.size) return [];
    // Packages may come from a source this run is about to add.
    for (const id of ctx.ids) if (isAptSource(id) && !(await ctx.x.user.lstat(id.slice("file:".length)))) return [];
    return specs
      .filter((s) => !known.has(s.name))
      .map((s) => `pkg:apt:${s.name}: not found in the package lists (try \`apt-get update\`, or check the Debian name — e.g. fd is fd-find)`);
  },

  async read(items, x) {
    const out = new Map<string, PacmanLive | null>();
    if (!items.length) return out;
    const [all, man] = await Promise.all([installed(x.user), manual(x.user)]);
    for (const { id } of items) out.set(id, all.has(name(id)) ? { explicit: man.has(name(id)) } : null);
    return out;
  },

  diff(_spec, live, prev) {
    if (!live) return { op: "change", action: "create" };
    if (!live.explicit) return { op: "change", action: "update", note: "installed automatically → mark manual" };
    return { op: "noop", meta: prev ?? { adopted: true } };
  },

  async apply(changes, x, ctx) {
    const results: Result<PacmanMeta>[] = [];
    const creates = changes.filter((c) => c.action === "create");
    const marks = changes.filter((c) => c.action === "update");
    if (creates.length) {
      const sourcesChanged = [...ctx.changed].some(isAptSource);
      const r = await install(creates.map((c) => c.spec.name), x.system, sourcesChanged, ctx.verbose);
      for (const c of creates)
        results.push(r.code === 0 ? { id: c.id, ok: true, meta: { installed: true } } : { id: c.id, ok: false, error: `install failed: ${tail(r.stderr) || `exit ${r.code}`}` });
    }
    if (marks.length) {
      const r = await x.system.run(["apt-mark", "manual", ...marks.map((c) => c.spec.name)], { stream: ctx.verbose, env: ENV });
      for (const c of marks)
        results.push(r.code === 0 ? { id: c.id, ok: true, meta: { ...c.prevMeta, markedExplicit: true } } : { id: c.id, ok: false, error: tail(r.stderr) });
    }
    return results;
  },

  planDestroy: planPkgDestroy,

  async destroy(items, x, ctx) {
    const results: Result<null>[] = [];
    const remove = items.filter((i) => i.meta.installed).map((i) => i.id);
    const demote = items.filter((i) => !i.meta.installed).map((i) => i.id);

    const asAuto = async (ids: string[]) => {
      const r = await x.system.run(["apt-mark", "auto", ...ids.map(name)], { stream: ctx.verbose, env: ENV });
      if (r.code !== 0) throw new Error(tail(r.stderr));
    };

    if (remove.length) {
      const r = await aptGet(x.system, ["purge", ...remove.map(name)], ctx.verbose);
      if (r.code === 0) {
        for (const id of remove) results.push({ id, ok: true, meta: null });
      } else {
        // Usually something still depends on it: retry one by one, demoting what can't be removed.
        for (const id of remove) {
          const one = await aptGet(x.system, ["purge", name(id)], ctx.verbose);
          if (one.code === 0) {
            results.push({ id, ok: true, meta: null });
            continue;
          }
          try {
            await asAuto([id]);
            results.push({ id, ok: true, meta: null, note: "still required; marked automatic" });
          } catch (e) {
            results.push({ id, ok: false, error: errMsg(e) });
          }
        }
      }
    }
    if (demote.length) {
      try {
        await asAuto(demote);
        for (const id of demote) results.push({ id, ok: true, meta: null });
      } catch (e) {
        for (const id of demote) results.push({ id, ok: false, error: errMsg(e) });
      }
    }
    // Dependencies only pulled in by what we removed or demoted.
    if (results.some((r) => r.ok)) await aptGet(x.system, ["autoremove", "--purge"], ctx.verbose);
    return results;
  },

  async extraneous({ declared, facts, keep, demote, only, orphans }, x) {
    if (facts.os.family !== "debian") return [];
    if (orphans) {
      // What `apt-get autoremove` would take: automatically installed and no longer required.
      const r = await x.user.run(["apt-get", "-s", "autoremove"], { env: ENV });
      const kept = [...keep, ...APT_PROTECTED].map((k) => new Bun.Glob(k));
      const meta: PacmanMeta = { installed: true, extraneous: true, orphan: true };
      return lines(r.stdout)
        .map((l) => /^Remv (\S+)/.exec(l)?.[1])
        .filter((n): n is string => !!n && !declared.has(prefix + n) && !kept.some((g) => g.match(n)))
        .sort()
        .map((n) => ({ id: prefix + n, scope: "system" as const, meta, display: n }));
    }
    const [man, prio] = await Promise.all([
      manual(x.user),
      x.user.run(["dpkg-query", "-W", "-f", "${Package}\t${Priority}\n"], { env: ENV }),
    ]);
    // "Explicit" on Debian is the manual set minus what the installer considers part of the base system.
    const base = new Set(
      lines(prio.stdout)
        .map((l) => l.split("\t"))
        .filter(([, p]) => p === "required" || p === "important")
        .map(([n]) => n!),
    );
    const kept = [...keep, ...APT_PROTECTED].map((k) => new Bun.Glob(k));
    const wanted = only?.map((k) => new Bun.Glob(k));
    const meta: PacmanMeta = demote
      ? { markedExplicit: true, extraneous: true, ...(only ? { requested: true } : {}) }
      : { installed: true, extraneous: true, ...(only ? { requested: true } : {}) };
    return [...man]
      .filter((n) => !base.has(n) && !declared.has(prefix + n) && !kept.some((g) => g.match(n)) && (!wanted || wanted.some((g) => g.match(n))))
      .sort()
      .map((n) => ({ id: prefix + n, scope: "system" as const, meta, display: n }));
  },
};
