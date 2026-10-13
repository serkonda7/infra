import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Executors, Facts, ResourceType, RunOptions } from "../src/types.ts";
import { FakeExecutor, ok, fail } from "../src/exec/fake.ts";
import { evaluate } from "../src/config/context.ts";
import { host, type HostDef, type ModuleRef } from "../src/config/define.ts";
import { makePlan, type Plan } from "../src/plan/plan.ts";
import { applyPlan, type ApplyOptions } from "../src/apply/apply.ts";
import { typeRegistry } from "../src/resources/index.ts";
import { StateStore } from "../src/state/state.ts";
import { makeFilter } from "../src/engine.ts";

const list = (xs: Iterable<string>) => ok([...xs].join("\n") + "\n");

/** In-memory pacman (+ paru): name → explicit? */
export class FakePacman {
  installed = new Map<string, boolean>();
  repo = new Set(["git", "neovim", "ripgrep", "fd", "steam", "htop", "base-devel", "paru", "docker", "linux-cachyos"]);
  aur = new Set(["visual-studio-code-bin", "yay-bin"]);
  foreign = new Set<string>();
  groups = new Set(["plasma"]);
  repos = ["core", "extra"];
  required = new Set<string>(); // packages that -Rns refuses to remove

  handle = (argv: string[]) => {
    if (argv[0] === "sh" && argv[2] === "command -v paru") return this.installed.has("paru") ? ok("/usr/bin/paru\n") : fail("", 1);
    if (argv[0] === "pacman-conf" && argv[1] === "--repo-list") return list(this.repos);
    if (argv[0] === "paru") {
      const names = argv.slice(1).filter((a) => !a.startsWith("-"));
      if (names.some((n) => !this.aur.has(n))) return fail("error: target not found");
      for (const n of names) this.installed.set(n, true), this.foreign.add(n);
      return ok();
    }
    if (argv[0] !== "pacman") return undefined;
    const [, op, ...rest] = argv;
    const names = rest.filter((a) => !a.startsWith("-"));
    switch (op) {
      case "-Qq": return list(this.installed.keys());
      case "-Qqe": return list([...this.installed].filter(([, e]) => e).map(([n]) => n));
      case "-Qqm": return list([...this.installed.keys()].filter((n) => this.foreign.has(n)));
      case "-Slq": return list(this.repo);
      case "-Sg": return list(this.groups);
      case "-Sy": return ok();
      case "-S":
      case "-Su":
        if (names.some((n) => !this.repo.has(n))) return fail("error: target not found");
        for (const n of names) this.installed.set(n, true);
        return ok();
      case "-D":
        for (const n of names) this.installed.set(n, rest.includes("--asexplicit"));
        return ok();
      case "-Rns":
        if (names.some((n) => this.required.has(n))) return fail("error: failed to prepare transaction (could not satisfy dependencies)");
        for (const n of names) this.installed.delete(n);
        return ok();
    }
    return fail(`fake pacman: unhandled ${argv.join(" ")}`);
  };
}

/** In-memory dpkg/apt: name → manually installed? */
export class FakeApt {
  installed = new Map<string, boolean>();
  available = new Set(["git", "neovim", "ripgrep", "fd-find", "caddy", "htop", "build-essential", "nftables", "openssh-server", "linux-image-amd64"]);
  priority = new Map<string, string>([["bash", "required"], ["apt", "important"]]);
  /** Packages only known after `apt-get update` (from a newly added source). */
  pending = new Set<string>();
  updates = 0;
  required = new Set<string>(); // packages purge refuses to remove

  handle = (argv: string[], opts?: RunOptions) => {
    const names = argv.filter((a, i) => i > 0 && !a.startsWith("-") && argv[i - 1] !== "-o" && argv[i - 1] !== "-f");
    switch (argv[0]) {
      case "dpkg-query":
        if (argv.includes("${Package}\t${Priority}\n")) return list([...this.installed.keys()].map((n) => `${n}\t${this.priority.get(n) ?? "optional"}`));
        return list([...this.installed.keys()].map((n) => `${n}\tii `));
      case "apt-mark": {
        const [op, ...pkgs] = names;
        if (op === "showmanual") return list([...this.installed].filter(([, m]) => m).map(([n]) => n));
        for (const n of pkgs) this.installed.set(n, op === "manual");
        return ok();
      }
      case "apt-cache":
        return list(this.available);
      case "apt-get": {
        if (opts?.env?.DEBIAN_FRONTEND !== "noninteractive") return fail("apt-get must run noninteractively");
        const [op, ...pkgs] = names;
        if (op === "update") {
          this.updates++;
          for (const n of this.pending) this.available.add(n);
          this.pending.clear();
          return ok();
        }
        if (op === "install") {
          const missing = pkgs.filter((n) => !this.available.has(n));
          if (missing.length) return fail(`E: Unable to locate package ${missing[0]}`, 100);
          for (const n of pkgs) this.installed.set(n, true);
          return ok();
        }
        if (op === "purge") {
          if (pkgs.some((n) => this.required.has(n))) return fail("E: Unmet dependencies", 100);
          for (const n of pkgs) this.installed.delete(n);
          return ok();
        }
        if (op === "autoremove") return ok();
        return fail(`fake apt-get: unhandled ${argv.join(" ")}`);
      }
    }
    return undefined;
  };
}

/** In-memory systemd: "system:name" / "user:name" → state. */
export class FakeSystemd {
  units = new Map<string, { state: string; active: string }>();
  reloads: string[] = [];

  add(name: string, state = "disabled", active = "inactive", user = false) {
    this.units.set(`${user ? "user" : "system"}:${name}`, { state, active });
  }
  get(name: string, user = false) {
    return this.units.get(`${user ? "user" : "system"}:${name}`);
  }

  handle = (argv: string[]) => {
    if (argv[0] !== "systemctl") return undefined;
    const user = argv[1] === "--user";
    const [op, ...rest] = argv.slice(user ? 2 : 1);
    const names = rest.filter((a) => !a.startsWith("-"));
    const key = (n: string) => `${user ? "user" : "system"}:${n}`;
    if (op === "show")
      return ok(
        names
          .map((n) => {
            const u = this.units.get(key(n));
            return u ? `LoadState=loaded\nUnitFileState=${u.state}\nActiveState=${u.active}` : `LoadState=not-found\nUnitFileState=\nActiveState=inactive`;
          })
          .join("\n\n") + "\n",
      );
    if (op === "daemon-reload") return this.reloads.push(user ? "user" : "system"), ok();
    for (const n of names) {
      const u = this.units.get(key(n));
      if (!u) return fail(`Unit ${n} not found.`);
      if (op === "enable") u.state = "enabled";
      else if (op === "disable") u.state = "disabled";
      else if (op === "start") u.active = "active";
      else if (op === "stop") u.active = "inactive";
      else if (op !== "try-restart") return fail(`fake systemctl: unhandled ${op}`);
    }
    return ok();
  };
}

/** In-memory /etc/passwd + /etc/group. */
export class FakeAccounts {
  users = new Map<string, { uid: number; gid: number; home: string; shell: string }>([["tester", { uid: 1000, gid: 1000, home: "/home/tester", shell: "/bin/bash" }]]);
  groups = new Map<string, { gid: number; members: string[] }>([
    ["tester", { gid: 1000, members: [] }],
    ["wheel", { gid: 998, members: ["tester"] }],
  ]);
  private next = 2000;

  handle = (argv: string[]) => {
    const args = argv.slice(1);
    const pos = args.filter((a, i) => !a.startsWith("-") && !["--groups", "--shell", "--uid", "--gid", "--home-dir"].includes(args[i - 1] ?? ""));
    const opt = (name: string) => {
      const i = args.indexOf(name);
      return i >= 0 ? args[i + 1] : undefined;
    };
    switch (argv[0]) {
      case "getent":
        if (args[0] === "group") return list([...this.groups].map(([n, g]) => `${n}:x:${g.gid}:${g.members.join(",")}`));
        return list([...this.users].map(([n, u]) => `${n}:x:${u.uid}:${u.gid}::${u.home}:${u.shell}`));
      case "groupadd": {
        const name = pos.at(-1)!;
        if (this.groups.has(name)) return fail(`groupadd: group '${name}' already exists`, 9);
        this.groups.set(name, { gid: Number(opt("--gid") ?? this.next++), members: [] });
        return ok();
      }
      case "groupdel":
        this.groups.delete(pos.at(-1)!);
        return ok();
      case "useradd": {
        const name = pos.at(-1)!;
        const uid = Number(opt("--uid") ?? this.next++);
        this.users.set(name, { uid, gid: uid, home: opt("--home-dir") ?? `/home/${name}`, shell: opt("--shell") ?? "/bin/bash" });
        return ok();
      }
      case "userdel":
        this.users.delete(pos.at(-1)!);
        return ok();
      case "usermod": {
        const name = pos.at(-1)!;
        const u = this.users.get(name);
        if (!u) return fail(`usermod: user '${name}' does not exist`, 6);
        if (opt("--shell")) u.shell = opt("--shell")!;
        for (const g of opt("--groups")?.split(",") ?? []) {
          const gr = this.groups.get(g);
          if (!gr) return fail(`usermod: group '${g}' does not exist`, 6);
          if (!gr.members.includes(name)) gr.members.push(name);
        }
        return ok();
      }
      case "gpasswd": {
        const [user, group] = pos;
        const gr = this.groups.get(group!);
        if (gr) gr.members = gr.members.filter((m) => m !== user);
        return ok();
      }
    }
    return undefined;
  };
}

/** In-memory flatpak: app → origin remote. */
export class FakeFlatpak {
  installed = new Map<string, string>();
  remotes = new Set<string>();
  available = new Set(["org.mozilla.firefox", "com.valvesoftware.Steam", "org.kde.krita"]);

  handle = (argv: string[]) => {
    if (argv[0] !== "flatpak") return undefined;
    const [, op, ...rest] = argv;
    const pos = rest.filter((a) => !a.startsWith("-"));
    switch (op) {
      case "list":
        return list([...this.installed].map(([app, origin]) => `${app}\t${origin}`));
      case "remote-add":
        this.remotes.add(pos[0]!);
        return ok();
      case "install": {
        const [remote, ...apps] = pos;
        if (!this.remotes.has(remote!)) return fail(`error: No remote refs found for '${remote}'`);
        if (apps.some((a) => !this.available.has(a))) return fail("error: Nothing matches");
        for (const a of apps) this.installed.set(a, remote!);
        return ok();
      }
      case "uninstall":
        for (const a of pos) this.installed.delete(a);
        return ok();
    }
    return fail(`fake flatpak: unhandled ${argv.join(" ")}`);
  };
}

/** kwriteconfig6 against real files, with just enough INI handling for tests. */
export const fakeKwriteconfig = (argv: string[]) => {
  if (argv[0] !== "kwriteconfig6") return undefined;
  const opt = (n: string) => argv.flatMap((a, i) => (a === n ? [argv[i + 1]!] : []));
  const file = opt("--file")[0]!;
  const header = `[${opt("--group").join("][")}]`;
  const key = opt("--key")[0]!;
  const value = argv.includes("--delete") ? null : argv.at(-1)!;
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l, i, a) => l || i < a.length - 1) : [];
  let start = lines.indexOf(header);
  if (start < 0) {
    if (value === null) return ok();
    lines.push(...(lines.length ? [""] : []), header);
    start = lines.length - 1;
  }
  let end = lines.findIndex((l, i) => i > start && l.startsWith("["));
  if (end < 0) end = lines.length;
  const at = lines.findIndex((l, i) => i > start && i < end && l.startsWith(`${key}=`));
  if (value === null) at >= 0 && lines.splice(at, 1);
  else if (at >= 0) lines[at] = `${key}=${value}`;
  else lines.splice(end > start + 1 && !lines[end - 1] ? end - 1 : end, 0, `${key}=${value}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join("\n") + "\n");
  return ok();
};

export function makeEnv(opts: { os?: "arch" | "debian"; types?: ResourceType[] } = {}) {
  const debian = opts.os === "debian";
  const root = mkdtempSync(join(tmpdir(), "rig-test-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  const sys = join(root, "sys"); // stands in for / — outside home, so "system" scope
  for (const d of [home, repo, sys]) mkdirSync(d, { recursive: true });
  const facts: Facts = {
    hostname: "testhost",
    os: debian
      ? { family: "debian", id: "debian", idLike: [], name: "Debian GNU/Linux 13 (trixie)", version: "13", codename: "trixie" }
      : { family: "arch", id: "cachyos", idLike: ["arch"], name: "CachyOS", version: "", codename: "" },
    arch: "x86_64",
    cpu: { vendor: "AuthenticAMD", model: "test", level: "x86-64-v3" },
    gpu: { vendor: "amd", all: ["amd"] },
    rootfs: "btrfs",
    init: "systemd",
    user: { name: "tester", uid: 1000, home },
    users: [],
    boot: { loader: debian ? "grub" : "limine" },
  };
  const pacman = new FakePacman();
  const systemd = new FakeSystemd();
  const accounts = new FakeAccounts();
  const apt = new FakeApt();
  const flatpak = new FakeFlatpak();
  const handlers = [pacman.handle, apt.handle, systemd.handle, accounts.handle, flatpak.handle, fakeKwriteconfig];
  const user = new FakeExecutor({ handlers: [...handlers] });
  const system = new FakeExecutor({ privileged: true, handlers: [...handlers] });
  const x: Executors = { user, system };
  const state = new StateStore(join(root, "state"));
  const types = typeRegistry(opts.types ?? []);

  const evalHost = (modules: ModuleRef[], secrets?: (name: string) => Uint8Array) =>
    evaluate(host({ os: facts.os.family as "arch" | "debian", modules }), { facts, repo, hostName: "testhost", root: sys, secrets, types: opts.types });

  async function plan(modules: ModuleRef[], opts: PlanOpts = {}): Promise<Plan> {
    const g = evalHost(modules, opts.secrets);
    const order = g.finalize();
    if (g.errors.length) throw new Error(g.errors.join("\n"));
    const exact = opts.packages?.mode === "exact" ? { keep: ["base", ...(opts.packages.keep ?? [])], demote: opts.demote ?? false } : undefined;
    return makePlan({ host: "testhost", facts, graph: g, order, prev: await state.latest("testhost"), types, x, repo, force: opts.force, filter: makeFilter(opts), exact });
  }

  async function apply(modules: ModuleRef[], opts: PlanOpts = {}) {
    const p = await plan(modules, opts);
    const outcome = await applyPlan(p, { x, objects: state.objects(), repo, commit: null, force: opts.force, guard: opts.guard });
    if (outcome.dirty) await state.write(outcome.generation);
    return { plan: p, ...outcome };
  }

  return { root, home, repo, sys, facts, pacman, apt, systemd, accounts, flatpak, user, system, x, state, types, evalHost, plan, apply };
}

type PlanOpts = {
  force?: boolean;
  userOnly?: boolean;
  only?: string;
  packages?: HostDef["packages"];
  demote?: boolean;
  secrets?: (name: string) => Uint8Array;
  guard?: ApplyOptions["guard"];
};

/** Commands run through an executor, as strings, minus read-only queries. */
export const mutations = (calls: string[][]) =>
  calls
    .map((c) => c.join(" "))
    .filter((c) => !/^(pacman -Q|pacman -S[lg]|systemctl (--user )?show|getent|sh -c command -v|pacman-conf|dpkg-query|apt-mark showmanual|apt-cache|flatpak list|git -C \S+ (rev-parse|remote|symbolic-ref|status|log|stash)|ls -A)/.test(c));

export const ops = (p: Plan) =>
  p.items.filter((i) => i.op !== "noop").map((i) => `${i.op === "change" ? i.action : i.op} ${i.id}`).sort();
