// Users, groups and group memberships. Accounts hold data, so they are only
// ever deleted when the declaration opts in with `prune: true`.

import type { Executors, ResourceBase, ResourceType, Result } from "../types.ts";
import { errMsg, lines } from "./util.ts";

const tail = (s: string) => s.trim().split("\n").slice(-4).join("\n");

async function getent(x: Executors, db: "passwd" | "group") {
  const r = await x.user.run(["getent", db]);
  return lines(r.stdout).map((l) => l.split(":"));
}

async function must(x: Executors, argv: string[], verbose: boolean) {
  const r = await x.system.run(argv, { stream: verbose });
  if (r.code !== 0) throw new Error(`${argv[0]} failed: ${tail(r.stderr) || `exit ${r.code}`}`);
}

// ---------------------------------------------------------------------------
// group:<name>

export interface GroupSpec extends ResourceBase {
  name: string;
  system?: boolean;
  gid?: number;
  prune?: boolean;
}

export interface GroupLive {
  gid: number;
}

export interface GroupMeta {
  created?: boolean;
  prune?: boolean;
}

export const groupType: ResourceType<GroupSpec, GroupLive, GroupMeta> = {
  kind: "group",
  label: "groups",
  order: 45,
  afterPackages: true,
  scope: () => "system",
  id: (s) => `group:${s.name}`,
  display: (id) => id.slice("group:".length),
  equal: (a, b) => a.system === b.system && a.gid === b.gid && a.prune === b.prune,

  async read(items, x) {
    const all = new Map((await getent(x, "group")).map((f) => [f[0]!, { gid: Number(f[2]) }]));
    return new Map(items.map(({ id }) => [id, all.get(id.slice("group:".length)) ?? null]));
  },

  diff(spec, live, prev) {
    if (!live) return { op: "change", action: "create" };
    if (spec.gid !== undefined && spec.gid !== live.gid) return { op: "blocked", reason: `exists with gid ${live.gid}, not ${spec.gid}; rig won't renumber groups` };
    return { op: "noop", meta: prev ? { ...prev, prune: spec.prune } : {} };
  },

  async apply(changes, x, ctx) {
    const results: Result<GroupMeta>[] = [];
    for (const { id, spec } of changes) {
      try {
        await must(x, ["groupadd", ...(spec.system ? ["--system"] : []), ...(spec.gid !== undefined ? ["--gid", String(spec.gid)] : []), "--", spec.name], ctx.verbose);
        results.push({ id, ok: true, meta: { created: true, prune: spec.prune } });
      } catch (e) {
        results.push({ id, ok: false, error: errMsg(e) });
      }
    }
    return results;
  },

  planDestroy(_id, meta, live) {
    if (!live) return { op: "forget", note: "already gone" };
    if (!meta.created) return { op: "forget", note: "existed before rig; kept" };
    if (!meta.prune) return { op: "forget", note: "kept (declare with prune: true to delete)" };
    return { op: "destroy" };
  },

  async destroy(items, x, ctx) {
    const results: Result<null>[] = [];
    for (const { id } of items) {
      try {
        await must(x, ["groupdel", "--", id.slice("group:".length)], ctx.verbose);
        results.push({ id, ok: true, meta: null });
      } catch (e) {
        results.push({ id, ok: false, error: errMsg(e) });
      }
    }
    return results;
  },
};

// ---------------------------------------------------------------------------
// user:<name>

export interface UserSpec extends ResourceBase {
  name: string;
  system?: boolean;
  uid?: number;
  home?: string;
  shell?: string;
  prune?: boolean;
}

export interface UserLive {
  uid: number;
  home: string;
  shell: string;
}

export interface UserMeta {
  created?: boolean;
  prune?: boolean;
  /** Login shell before rig changed it. */
  shell?: string;
}

export const userType: ResourceType<UserSpec, UserLive, UserMeta> = {
  kind: "user",
  label: "users",
  order: 46,
  afterPackages: true,
  scope: () => "system",
  id: (s) => `user:${s.name}`,
  display: (id) => id.slice("user:".length),
  equal: (a, b) => a.system === b.system && a.uid === b.uid && a.home === b.home && a.shell === b.shell && a.prune === b.prune,

  async read(items, x) {
    const all = new Map((await getent(x, "passwd")).map((f) => [f[0]!, { uid: Number(f[2]), home: f[5] ?? "", shell: f[6] ?? "" }]));
    return new Map(items.map(({ id }) => [id, all.get(id.slice("user:".length)) ?? null]));
  },

  diff(spec, live, prev) {
    if (!live) return { op: "change", action: "create" };
    if (spec.uid !== undefined && spec.uid !== live.uid) return { op: "blocked", reason: `exists with uid ${live.uid}, not ${spec.uid}; rig won't renumber users` };
    if (spec.home !== undefined && spec.home !== live.home) return { op: "blocked", reason: `home is ${live.home}, not ${spec.home}; rig won't move home directories` };
    if (spec.shell !== undefined && spec.shell !== live.shell) return { op: "change", action: "update", note: `shell ${live.shell} → ${spec.shell}` };
    return { op: "noop", meta: prev ? { ...prev, prune: spec.prune } : {} };
  },

  async apply(changes, x, ctx) {
    const results: Result<UserMeta>[] = [];
    for (const { id, spec, live, prevMeta } of changes) {
      try {
        if (!live) {
          const args = ["useradd", spec.system ? "--system" : "--create-home"];
          if (spec.uid !== undefined) args.push("--uid", String(spec.uid));
          if (spec.home) args.push("--home-dir", spec.home);
          if (spec.shell) args.push("--shell", spec.shell);
          await must(x, [...args, "--", spec.name], ctx.verbose);
          results.push({ id, ok: true, meta: { created: true, prune: spec.prune } });
        } else {
          await must(x, ["usermod", "--shell", spec.shell!, "--", spec.name], ctx.verbose);
          results.push({ id, ok: true, meta: { ...prevMeta, shell: prevMeta?.shell ?? live.shell, prune: spec.prune } });
        }
      } catch (e) {
        results.push({ id, ok: false, error: errMsg(e) });
      }
    }
    return results;
  },

  planDestroy(_id, meta, live) {
    if (!live) return { op: "forget", note: "already gone" };
    if (meta.created && meta.prune) return { op: "destroy", note: "home directory is kept" };
    if (meta.shell && meta.shell !== live.shell) return { op: "destroy", note: `restore shell ${meta.shell}` };
    return { op: "forget", note: meta.created ? "kept (declare with prune: true to delete)" : "existed before rig; kept" };
  },

  async destroy(items, x, ctx) {
    const results: Result<null>[] = [];
    for (const { id, meta } of items) {
      const name = id.slice("user:".length);
      try {
        if (meta.created && meta.prune) await must(x, ["userdel", "--", name], ctx.verbose);
        else await must(x, ["usermod", "--shell", meta.shell!, "--", name], ctx.verbose);
        results.push({ id, ok: true, meta: null });
      } catch (e) {
        results.push({ id, ok: false, error: errMsg(e) });
      }
    }
    return results;
  },
};

// ---------------------------------------------------------------------------
// member:<user>:<group>

export interface MemberSpec extends ResourceBase {
  user: string;
  group: string;
}

export interface MemberLive {
  /** The group exists. */
  group: boolean;
  member: boolean;
}

export interface MemberMeta {
  /** rig added the membership, so it removes it again once undeclared. */
  added?: boolean;
}

const parseMember = (id: string) => {
  const [user, group] = id.slice("member:".length).split(":");
  return { user: user!, group: group! };
};

export const memberType: ResourceType<MemberSpec, MemberLive, MemberMeta> = {
  kind: "member",
  label: "group memberships",
  order: 47,
  afterPackages: true,
  scope: () => "system",
  id: (s) => `member:${s.user}:${s.group}`,
  display: (id) => {
    const { user, group } = parseMember(id);
    return `${user} ∈ ${group}`;
  },
  equal: () => true,

  async read(items, x) {
    const groups = await getent(x, "group");
    const passwd = await getent(x, "passwd");
    // Membership is the supplementary list or the primary group.
    const primary = new Map(passwd.map((f) => [f[0]!, f[3]]));
    const out = new Map<string, MemberLive | null>();
    for (const { id } of items) {
      const { user, group } = parseMember(id);
      const g = groups.find((f) => f[0] === group);
      out.set(id, g ? { group: true, member: (g[3] ?? "").split(",").includes(user) || primary.get(user) === g[2] } : { group: false, member: false });
    }
    return out;
  },

  diff(_spec, live, prev) {
    if (live?.member) return { op: "noop", meta: prev ?? {} };
    return { op: "change", action: "create", note: live?.group ? undefined : "group does not exist yet" };
  },

  async apply(changes, x, ctx) {
    const results: Result<MemberMeta>[] = [];
    const byUser = new Map<string, typeof changes>();
    for (const c of changes) (byUser.get(c.spec.user) ?? byUser.set(c.spec.user, []).get(c.spec.user)!).push(c);
    for (const [user, list] of byUser) {
      try {
        await must(x, ["usermod", "--append", "--groups", list.map((c) => c.spec.group).join(","), "--", user], ctx.verbose);
        const note = user === ctx.user ? "takes effect at next login" : undefined;
        for (const c of list) results.push({ id: c.id, ok: true, meta: { added: true }, note });
      } catch (e) {
        for (const c of list) results.push({ id: c.id, ok: false, error: errMsg(e) });
      }
    }
    return results;
  },

  planDestroy(_id, meta, live) {
    if (!live?.member) return { op: "forget", note: "not a member anymore" };
    if (!meta.added) return { op: "forget", note: "member before rig; kept" };
    return { op: "destroy" };
  },

  async destroy(items, x, ctx) {
    const results: Result<null>[] = [];
    for (const { id } of items) {
      const { user, group } = parseMember(id);
      try {
        await must(x, ["gpasswd", "--delete", user, group], ctx.verbose);
        results.push({ id, ok: true, meta: null });
      } catch (e) {
        results.push({ id, ok: false, error: errMsg(e) });
      }
    }
    return results;
  },
};
