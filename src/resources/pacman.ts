import type { ApplyContext, DestroyPlan, Executor, Executors, ResourceBase, ResourceType, Result, RunResult, ValidateContext } from "../types.ts";
import { errMsg, lines } from "./util.ts";

export interface PacmanSpec extends ResourceBase {
  name: string;
}

export interface PacmanLive {
  explicit: boolean;
}

export interface PacmanMeta {
  /** rig installed it, so it may remove it once undeclared (additive mode). */
  installed?: boolean;
  /** It was installed as a dependency and rig marked it explicit. */
  markedExplicit?: boolean;
  /** Already explicitly installed before rig: never removed in additive mode. */
  adopted?: boolean;
  /** Not declared at all; pruned because of exact mode. */
  extraneous?: boolean;
}

export const tail = (s: string, n = 6) => s.trim().split("\n").slice(-n).join("\n");

export async function pacman(x: Executor, args: string[], verbose: boolean) {
  return x.run(["pacman", ...args], { stream: verbose, env: { LC_ALL: "C" } });
}

/** Repos declared in config that pacman doesn't know yet — their packages can't be validated before the first apply. */
async function pendingRepos(ctx: ValidateContext): Promise<string[]> {
  const declared = [...ctx.ids].filter((id) => id.startsWith("repo:pacman:")).map((id) => id.slice("repo:pacman:".length));
  if (!declared.length) return [];
  const r = await ctx.x.user.run(["pacman-conf", "--repo-list"]);
  const known = new Set(lines(r.stdout));
  return declared.filter((n) => !known.has(n));
}

/** Shared by every package backend: remove what rig installed, demote what it only marked explicit. */
export function planPkgDestroy(_id: string, meta: PacmanMeta, live: PacmanLive | null): DestroyPlan {
  if (!live) return { op: "forget", note: "already removed" };
  if (meta.extraneous) {
    if (!live.explicit) return { op: "forget", note: "no longer explicit" };
    return { op: "destroy", note: meta.installed ? "not declared (exact mode)" : "not declared; mark as dependency" };
  }
  if (meta.installed) return { op: "destroy" };
  if (meta.markedExplicit && live.explicit) return { op: "destroy", note: "mark as dependency" };
  return { op: "forget", note: "installed before rig; kept" };
}

interface Backend {
  kind: "pkg:pacman" | "pkg:aur";
  label: string;
  order: number;
  validate(names: string[], ctx: ValidateContext): Promise<string[]>;
  install(names: string[], x: Executors, ctx: ApplyContext): Promise<RunResult>;
  /** Is this explicitly-installed package one of ours (repo vs. foreign)? */
  owns(name: string, foreign: ReadonlySet<string>): boolean;
}

function pkgType(b: Backend): ResourceType<PacmanSpec, PacmanLive, PacmanMeta> {
  const prefix = b.kind + ":";
  const name = (id: string) => id.slice(prefix.length);
  return {
    kind: b.kind,
    label: b.label,
    order: b.order,
    scope: () => "system",
    id: (s) => prefix + s.name,
    display: (id) => name(id),
    equal: () => true,

    async validate(specs, ctx) {
      if (!specs.length) return [];
      if (ctx.facts.os.family !== "arch") return [`${b.kind} packages declared, but this host is ${ctx.facts.os.name}`];
      return b.validate(specs.map((s) => s.name), ctx);
    },

    async read(items, x) {
      const out = new Map<string, PacmanLive | null>();
      if (!items.length) return out;
      const [all, explicit] = await Promise.all([x.user.run(["pacman", "-Qq"]), x.user.run(["pacman", "-Qqe"])]);
      const installed = new Set(lines(all.stdout));
      const exp = new Set(lines(explicit.stdout));
      for (const { id } of items) {
        const n = name(id);
        out.set(id, installed.has(n) ? { explicit: exp.has(n) } : null);
      }
      return out;
    },

    diff(_spec, live, prev) {
      if (!live) return { op: "change", action: "create" };
      if (!live.explicit) return { op: "change", action: "update", note: "installed as dependency → mark explicit" };
      return { op: "noop", meta: prev ?? { adopted: true } };
    },

    async apply(changes, x, ctx) {
      const results: Result<PacmanMeta>[] = [];
      const creates = changes.filter((c) => c.action === "create");
      const marks = changes.filter((c) => c.action === "update");
      if (creates.length) {
        // One transaction for everything; pacman is all-or-nothing here.
        const r = await b.install(creates.map((c) => c.spec.name), x, ctx);
        for (const c of creates)
          results.push(r.code === 0 ? { id: c.id, ok: true, meta: { installed: true } } : { id: c.id, ok: false, error: `install failed: ${tail(r.stderr) || `exit ${r.code}`}` });
      }
      if (marks.length) {
        const r = await pacman(x.system, ["-D", "--asexplicit", ...marks.map((c) => c.spec.name)], ctx.verbose);
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

      const asDeps = async (ids: string[]) => {
        const r = await pacman(x.system, ["-D", "--asdeps", ...ids.map(name)], ctx.verbose);
        if (r.code !== 0) throw new Error(tail(r.stderr));
      };

      if (remove.length) {
        const r = await pacman(x.system, ["-Rns", "--noconfirm", ...remove.map(name)], ctx.verbose);
        if (r.code === 0) {
          for (const id of remove) results.push({ id, ok: true, meta: null });
        } else {
          // Usually "required by": retry one by one, demoting what can't be removed.
          for (const id of remove) {
            const one = await pacman(x.system, ["-Rns", "--noconfirm", name(id)], ctx.verbose);
            if (one.code === 0) {
              results.push({ id, ok: true, meta: null });
              continue;
            }
            try {
              await asDeps([id]);
              results.push({ id, ok: true, meta: null, note: "still required; marked as dependency" });
            } catch (e) {
              results.push({ id, ok: false, error: errMsg(e) });
            }
          }
        }
      }
      if (demote.length) {
        try {
          await asDeps(demote);
          for (const id of demote) results.push({ id, ok: true, meta: null });
        } catch (e) {
          for (const id of demote) results.push({ id, ok: false, error: errMsg(e) });
        }
      }
      return results;
    },

    async extraneous({ declared, keep, demote }, x) {
      const [explicit, foreignOut] = await Promise.all([x.user.run(["pacman", "-Qqe"]), x.user.run(["pacman", "-Qqm"])]);
      const foreign = new Set(lines(foreignOut.stdout));
      const kept = keep.map((k) => new Bun.Glob(k));
      const meta: PacmanMeta = demote ? { markedExplicit: true, extraneous: true } : { installed: true, extraneous: true };
      return lines(explicit.stdout)
        .filter((n) => b.owns(n, foreign) && !declared.has(prefix + n) && !kept.some((g) => g.match(n)))
        .map((n) => ({ id: prefix + n, scope: "system" as const, meta, display: n }));
    },
  };
}

export const pacmanType = pkgType({
  kind: "pkg:pacman",
  label: "packages (pacman)",
  order: 0,
  async validate(names, ctx) {
    const [sync, groups] = await Promise.all([ctx.x.user.run(["pacman", "-Slq"]), ctx.x.user.run(["pacman", "-Sg"])]);
    if (sync.code !== 0) return [`pacman -Slq failed: ${tail(sync.stderr)}`];
    const known = new Set(lines(sync.stdout));
    const groupSet = new Set(lines(groups.stdout));
    const unknown = names.filter((n) => !known.has(n));
    if (!unknown.length) return [];
    // Packages may come from a repo this run is about to add; pacman reports them at install time.
    if ((await pendingRepos(ctx)).length) return unknown.filter((n) => groupSet.has(n)).map((n) => `pkg:pacman:${n} is a package group — list its members or use a meta package`);
    return unknown.map((n) =>
      groupSet.has(n)
        ? `pkg:pacman:${n} is a package group — list its members or use a meta package`
        : `pkg:pacman:${n}: not found in sync repos (AUR packages go through pkg.aur; try \`pacman -Sy\` if repos are stale)`,
    );
  },
  install(names, x, ctx) {
    // A repo added in this run was synced with -Sy: upgrade in the same transaction so we never leave a partial upgrade.
    const synced = [...ctx.changed].some((id) => id.startsWith("repo:pacman:"));
    return pacman(x.system, [synced ? "-Su" : "-S", "--needed", "--noconfirm", ...names], ctx.verbose);
  },
  owns: (n, foreign) => !foreign.has(n),
});

export const aurType = pkgType({
  kind: "pkg:aur",
  label: "packages (AUR)",
  order: 1,
  async validate(names, ctx) {
    const sync = await ctx.x.user.run(["pacman", "-Slq"]);
    const known = new Set(lines(sync.stdout));
    return names.filter((n) => known.has(n)).map((n) => `pkg:aur:${n} is in the sync repos — declare it with pkg() instead`);
  },
  async install(names, x, ctx) {
    // makepkg refuses to run as root, so AUR builds run as the user; paru calls sudo for the final pacman -U.
    if ((await x.user.run(["sh", "-c", "command -v paru"])).code !== 0) {
      const boot = await pacman(x.system, ["-S", "--needed", "--noconfirm", "paru"], ctx.verbose);
      if (boot.code !== 0) return { ...boot, stderr: `bootstrapping paru failed (is the CachyOS repo enabled?): ${boot.stderr}` };
    }
    return x.user.run(["paru", "-S", "--needed", "--noconfirm", "--skipreview", ...names], { stream: ctx.verbose, env: { LC_ALL: "C" } });
  },
  owns: (n, foreign) => foreign.has(n),
});
