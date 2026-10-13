// Git checkouts: clone if missing, optionally keep a ref checked out. rig
// never pulls, resets or force-checks-out over local changes — a working
// copy is the user's. Clones are only deleted with `prune: true`, and only
// when nothing in them would be lost.

import type { Executor, ResourceBase, ResourceType, Result, Scope, StatType } from "../types.ts";
import { pick } from "../types.ts";
import { errMsg, idPath, lines, tilde } from "./util.ts";
import { tail } from "./pacman.ts";

export interface GitSpec extends ResourceBase {
  path: string;
  url: string;
  /** Branch, tag or commit to have checked out. Branches are checked out, not pulled. */
  ref?: string;
  /** Delete the clone once undeclared (only if it has no local changes or unpushed work). */
  prune?: boolean;
  scope: Scope;
}

export interface GitLive {
  type: StatType;
  /** A git work tree rooted at this path. */
  repo: boolean;
  /** Directory without any entries (cloning into it is fine). */
  empty?: boolean;
  origin?: string;
  head?: string;
  branch?: string;
  /** Tracked files modified. */
  dirty?: boolean;
  /** The spec's ref resolved locally; null when it has to be fetched first. */
  want?: string | null;
  /** The spec's ref names a branch (local or on origin). */
  branchRef?: boolean;
  /** Nothing would be lost by deleting it: clean, no untracked files, no unpushed commits, no stashes. */
  pristine?: boolean;
}

export interface GitMeta {
  url: string;
  ref?: string;
  /** rig cloned it (so it may delete it, with prune). */
  cloned?: boolean;
  prune?: boolean;
}

const ENV = { LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };

const git = (x: Executor, path: string, args: string[], verbose = false) => x.run(["git", "-C", path, ...args], { env: ENV, stream: verbose });
const out = async (x: Executor, path: string, args: string[]) => {
  const r = await git(x, path, args);
  return r.code === 0 ? r.stdout.trim() : null;
};

/** URLs that name the same remote: trailing slash and .git don't matter. */
export const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "").replace(/\.git$/, "") === b.replace(/\/+$/, "").replace(/\.git$/, "");

const shortUrl = (u: string) => u.replace(/^(https?:\/\/|ssh:\/\/|git@)/, "").replace(/\.git$/, "");

async function resolveRef(x: Executor, path: string, ref: string): Promise<string | null> {
  return (await out(x, path, ["rev-parse", "-q", "--verify", `${ref}^{commit}`])) ?? (await out(x, path, ["rev-parse", "-q", "--verify", `origin/${ref}^{commit}`]));
}

async function readOne(x: Executor, path: string, spec: GitSpec | undefined): Promise<GitLive | null> {
  const st = await x.lstat(path);
  if (!st) return null;
  if (st.type !== "dir") return { type: st.type, repo: false };
  const top = await out(x, path, ["rev-parse", "--show-toplevel"]);
  if (top !== path) {
    const ls = await x.run(["ls", "-A", "--", path]);
    return { type: "dir", repo: false, empty: ls.code === 0 && !ls.stdout.trim() };
  }
  const [origin, head, branch, status] = await Promise.all([
    out(x, path, ["remote", "get-url", "origin"]),
    out(x, path, ["rev-parse", "-q", "--verify", "HEAD"]),
    out(x, path, ["symbolic-ref", "-q", "--short", "HEAD"]),
    out(x, path, ["status", "--porcelain"]),
  ]);
  const live: GitLive = {
    type: "dir",
    repo: true,
    origin: origin ?? "",
    head: head ?? "",
    branch: branch ?? undefined,
    dirty: lines(status ?? "").some((l) => !l.startsWith("??")),
  };
  if (spec?.ref) {
    const [want, local, remote] = await Promise.all([
      resolveRef(x, path, spec.ref),
      git(x, path, ["show-ref", "--verify", "-q", `refs/heads/${spec.ref}`]),
      git(x, path, ["show-ref", "--verify", "-q", `refs/remotes/origin/${spec.ref}`]),
    ]);
    live.want = want;
    live.branchRef = local.code === 0 || remote.code === 0;
  }
  if (!spec) {
    const [unpushed, stashes] = await Promise.all([out(x, path, ["log", "--oneline", "-n1", "--branches", "--not", "--remotes"]), out(x, path, ["stash", "list"])]);
    live.pristine = status === "" && unpushed === "" && stashes === "";
  }
  return live;
}

/** Is the ref already checked out? A branch has to be the current branch (wherever it points); a tag or commit has to be HEAD. */
const atRef = (spec: GitSpec, live: GitLive) => !spec.ref || (live.branchRef ? live.branch === spec.ref : !!live.want && live.want === live.head);

/** Check out the spec's ref, fetching first when it isn't known locally. */
async function checkout(x: Executor, spec: GitSpec, verbose: boolean) {
  if (!spec.ref) return;
  if (!(await resolveRef(x, spec.path, spec.ref))) {
    const f = await git(x, spec.path, ["fetch", "--tags", "origin"], verbose);
    if (f.code !== 0) throw new Error(`git fetch failed: ${tail(f.stderr) || `exit ${f.code}`}`);
  }
  // Without --force: git refuses rather than overwrite local changes.
  const c = await git(x, spec.path, ["checkout", "-q", spec.ref], verbose);
  if (c.code !== 0) throw new Error(`git checkout ${spec.ref} failed: ${tail(c.stderr) || `exit ${c.code}`}`);
}

export const gitType: ResourceType<GitSpec, GitLive, GitMeta> = {
  kind: "git",
  label: "git checkouts",
  order: 15,
  scope: (s) => s.scope,
  id: (s) => `git:${s.path}`,
  display: (id, s, { home }) => {
    const p = tilde(idPath(id), home);
    return s ? `${p} ← ${shortUrl(s.url)}${s.ref ? ` @ ${s.ref}` : ""}` : p;
  },
  equal: (a, b) => sameUrl(a.url, b.url) && a.ref === b.ref && a.prune === b.prune,

  async read(items, x) {
    const res = new Map<string, GitLive | null>();
    await Promise.all(items.map(async ({ id, scope, spec }) => res.set(id, await readOne(pick(x, scope), idPath(id), spec))));
    return res;
  },

  diff(spec, live, prev) {
    const meta: GitMeta = { url: spec.url, ...(spec.ref ? { ref: spec.ref } : {}), ...(prev?.cloned ? { cloned: true } : {}), ...(spec.prune ? { prune: true } : {}) };
    if (!live || live.empty) return { op: "change", action: "create", note: `clone${spec.ref ? `, check out ${spec.ref}` : ""}` };
    if (live.type !== "dir") return { op: "blocked", reason: `a ${live.type} exists at this path` };
    if (!live.repo) return { op: "blocked", reason: "a directory that isn't a git checkout exists here" };
    if (!sameUrl(live.origin!, spec.url)) return { op: "blocked", reason: `origin is ${live.origin || "not set"}, not ${spec.url}` };
    if (atRef(spec, live)) return { op: "noop", meta };
    if (live.dirty) return { op: "blocked", reason: `has local changes; won't check out ${spec.ref} over them (commit or stash first)` };
    return { op: "change", action: "update", note: `${live.branch ?? live.head!.slice(0, 7)} → ${spec.ref}${live.want ? "" : " (fetch)"}` };
  },

  async apply(changes, x, ctx) {
    const results: Result<GitMeta>[] = [];
    for (const c of changes) {
      const { spec } = c;
      const ex = pick(x, spec.scope);
      try {
        if (c.action === "create") {
          const r = await ex.run(["git", "clone", "--", spec.url, spec.path], { env: ENV, stream: ctx.verbose });
          if (r.code !== 0) throw new Error(`git clone failed: ${tail(r.stderr) || `exit ${r.code}`}`);
        }
        await checkout(ex, spec, ctx.verbose);
        const cloned = c.action === "create" || c.prevMeta?.cloned;
        results.push({ id: c.id, ok: true, meta: { url: spec.url, ...(spec.ref ? { ref: spec.ref } : {}), ...(cloned ? { cloned: true } : {}), ...(spec.prune ? { prune: true } : {}) } });
      } catch (e) {
        results.push({ id: c.id, ok: false, error: errMsg(e) });
      }
    }
    return results;
  },

  planDestroy(_id, meta, live, ctx) {
    if (!live || !live.repo) return { op: "forget", note: "already gone" };
    if (!meta.cloned) return { op: "forget", note: "existed before rig; kept" };
    if (!meta.prune) return { op: "forget", note: "clone kept (declare with prune: true to delete it)" };
    if (!live.pristine && !ctx.force) return { op: "blocked", reason: "has local changes, untracked files, stashes or unpushed commits; delete it yourself or use --force" };
    return { op: "destroy", note: "delete clone" };
  },

  async destroy(items, x, ctx) {
    const results: Result<null>[] = [];
    for (const { id, scope } of items) {
      const r = await pick(x, scope).run(["rm", "-rf", "--", idPath(id)], { stream: ctx.verbose });
      results.push(r.code === 0 ? { id, ok: true, meta: null } : { id, ok: false, error: tail(r.stderr) || `exit ${r.code}` });
    }
    return results;
  },
};
