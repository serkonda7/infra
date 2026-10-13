import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import type { Facts, Provenance, ResourceBase, ResourceType } from "../types.ts";
import { Graph, fmtProv } from "../graph/graph.ts";
import { toInstance, type HostDef, type ModuleRef } from "./define.ts";
import { fileType, type FileSpec } from "../resources/file.ts";
import { linkType } from "../resources/link.ts";
import { dirType } from "../resources/dir.ts";
import { aurType, pacmanType } from "../resources/pacman.ts";
import { execType } from "../resources/exec.ts";
import { unitType, type UnitSpec } from "../resources/unit.ts";
import { groupType, memberType, userType } from "../resources/account.ts";
import { lineType, type LineSpec } from "../resources/line.ts";
import { repoType } from "../resources/repo.ts";
import { triggerType, type TriggerSpec } from "../resources/trigger.ts";
import { aptType, isAptSource } from "../resources/apt.ts";
import { FLATHUB, flatpakType, isAppId, type FlatpakSpec } from "../resources/flatpak.ts";
import { kconfigType, type KconfigSpec } from "../resources/kconfig.ts";
import { gitType, type GitSpec } from "../resources/git.ts";
import { builtinTypes } from "../resources/index.ts";
import { errMsg, isUnder, repoPath, scopeOf, targetPath, tilde, xxh } from "../resources/util.ts";
import { Secret, isSecret, reveal, revealText } from "../secrets/secret.ts";
import { checkName } from "../secrets/store.ts";

export type PkgName = string | { arch?: string; debian?: string };

/** Packages whose names differ between distros, keyed by Arch name. */
const ALIASES: Record<string, { debian: string }> = {
  fd: { debian: "fd-find" },
  bat: { debian: "bat" },
  openssh: { debian: "openssh-server" },
  "base-devel": { debian: "build-essential" },
  python: { debian: "python3" },
  "python-pip": { debian: "python3-pip" },
  nodejs: { debian: "nodejs" },
};

interface Deps {
  /** Resource IDs this resource must be applied after. */
  after?: string[];
}

export interface FileOptions extends Deps {
  content?: string | Uint8Array | Secret;
  /** Repo-relative file to copy. */
  source?: string;
  /** Permission bits; secrets default to 0600. */
  mode?: number;
}

export interface LinkTreeOptions {
  /** Globs (relative to the source dir) to skip. */
  ignore?: string[];
  /** "file" (default) links each leaf file; "dir" links top-level entries. */
  granularity?: "file" | "dir";
}

export interface ExecOptions extends Deps {
  unless?: string;
  creates?: string;
  onChange?: string[];
  undo?: string;
  /** Run as the invoking user instead of root. */
  asUser?: boolean;
}

export interface LinkFn {
  (path: string, source: string, opts?: Deps): string;
  /** Mirror a repo directory into a target directory, like GNU stow. */
  tree(source: string, dest: string, opts?: LinkTreeOptions): string[];
}

export interface FlatpakOptions extends Deps {
  /** Remote to install from (default "flathub", added automatically). */
  remote?: string;
  /** Add the remote from this .flatpakrepo URL if it isn't configured yet. */
  url?: string;
}

export type KconfigValue = string | number | boolean;

export interface GitOptions extends Deps {
  /** Branch, tag or commit to keep checked out. Branches are checked out, never pulled. */
  ref?: string;
  /** Delete the clone once undeclared — only if nothing in it would be lost. */
  prune?: boolean;
}

export interface PkgFn {
  (names: PkgName | PkgName[], opts?: Deps): string[];
  /** AUR packages, built with paru as the user (paru is bootstrapped from the repos if missing). */
  aur(names: string | string[], opts?: Deps): string[];
  /** A pacman repository section in pacman.conf (plus its signing keys), or on Debian an apt source (deb822) and its keyring. */
  repo(name: string, opts: RepoOptions | AptRepoOptions): string;
  /** Flatpak apps (reverse-DNS IDs), installed system-wide; the flatpak package comes along. */
  flatpak(apps: string | string[], opts?: FlatpakOptions): string[];
}

export interface UnitOptions extends Deps {
  /** Enable at boot (default true). `false` disables; omit-by-undefined leaves it alone. */
  enabled?: boolean;
  /** Running state; unmanaged unless given. */
  started?: boolean;
  /** systemd --user unit of the primary user. */
  user?: boolean;
  /** `systemctl try-restart` the unit at the end of the run if any of these resources changed. */
  restartOn?: string[];
}

export interface UnitFn {
  /** Manage a systemd unit's enablement and running state. Names without a suffix get `.service`. */
  (name: string, opts?: UnitOptions): string;
  /** Write a unit file (or a drop-in with `dropIn`) and daemon-reload when it changes. Returns the file ID. */
  define(name: string, content: string, opts?: Deps & { user?: boolean; dropIn?: string }): string;
}

export interface AccountOptions extends Deps {
  system?: boolean;
  uid?: number;
  home?: string;
  shell?: string;
  /** Supplementary groups (added, never removed while declared). */
  groups?: string[];
  /** Delete the account (not its home) once undeclared. Off by default: accounts own data. */
  prune?: boolean;
}

export interface UserFn {
  /** Declare a user account. */
  (name: string, opts?: AccountOptions): string;
  /** The primary user. */
  readonly name: string;
  readonly home: string;
  readonly email?: string;
  /** Add the primary user to supplementary groups. */
  groups(groups: string[], opts?: Deps): string[];
}

export interface LineOptions extends Deps {
  line: string;
  /** Replace the first line matching this instead of appending. */
  match?: RegExp;
  /** Stable identity (defaults to the match source, else the line). */
  key?: string;
}

export interface BlockOptions extends Deps {
  /** A marker-delimited block (`# BEGIN rig <key>` … `# END rig <key>`). */
  block: string;
  key: string;
  /** Comment prefix for the markers (default "#"). */
  comment?: string;
}

export interface RepoOptions extends Deps {
  include?: string;
  server?: string | string[];
  sigLevel?: string;
  /** "first" puts a new section above all other repos (they take priority). Default "last". */
  position?: "first" | "last";
  /** Signing key IDs to receive and locally sign. */
  keys?: string[];
  keyserver?: string;
  /** pacman.conf to edit (default /etc/pacman.conf). */
  conf?: string;
}

export interface AptRepoOptions extends Deps {
  uris: string | string[];
  /** Default: the host's release codename (facts.os.codename). */
  suites?: string | string[];
  /** Default: main. */
  components?: string | string[];
  types?: ("deb" | "deb-src")[];
  architectures?: string[];
  /** Signing key: an armored key block, or a repo path to an .asc/.gpg keyring. Written to /etc/apt/keyrings/<name>.{asc,gpg}. */
  key?: string;
}

export interface TriggerOptions {
  /** Resource IDs; the command runs once at the end if any of them changed. */
  on: string[];
  asUser?: boolean;
}

export interface Ctx {
  facts: Facts;
  host: string;
  /** Absolute path of the config repo. */
  repo: string;
  user: UserFn;
  vars: Record<string, unknown>;
  pkg: PkgFn;
  file(path: string, content: string | Uint8Array | Secret | FileOptions, opts?: Omit<FileOptions, "content" | "source">): string;
  link: LinkFn;
  dir(path: string, opts?: Deps & { mode?: number }): string;
  exec(cmd: string, opts?: ExecOptions): string;
  unit: UnitFn;
  group(name: string, opts?: Deps & { system?: boolean; gid?: number; prune?: boolean }): string;
  /** Kernel parameters, merged across modules into /etc/sysctl.d/90-rig.conf; applied with `sysctl --system`. */
  sysctl(values: Record<string, string | number>): string;
  /** Edit part of a file rig doesn't own: one line, or a marker-delimited block. */
  lineInFile(path: string, line: string | LineOptions | BlockOptions): string;
  /** Run a command once at the end of the run if any of `on` changed. */
  trigger(cmd: string, opts: TriggerOptions): string;
  /** Kernel command line parameters (Limine or GRUB), merged across modules; regenerates boot entries. */
  kernelParams(params: string[], opts?: { regenerate?: string }): string;
  /**
   * Individual keys in a KDE config file, written with kwriteconfig6; the rest of the file stays
   * yours. Bare file names live in ~/.config. Nested groups are written as in the file: "A][B".
   */
  kconfig(file: string, groups: Record<string, Record<string, KconfigValue>>, opts?: Deps): string[];
  /** A git checkout: cloned if missing, `ref` kept checked out. Never pulls or overwrites local changes. */
  git(path: string, url: string, opts?: GitOptions): string;
  /** Declare a resource of a custom type (registered with defineConfig({ types })). */
  resource<S extends ResourceBase>(type: ResourceType<S, any, any>, spec: NoInfer<S>, opts?: Deps): string;
  /**
   * Tagged template that strips the leading newline and common indentation.
   * Interpolating a secret makes the result a secret too.
   */
  tmpl: typeof tmpl;
  /** A decrypted secrets/<name>.age. Opaque: usable as file content or in tmpl, never as a plain string. */
  secret(name: string): Secret;
  include(...mods: ModuleRef[]): void;
}

type Plain = string | number | boolean | bigint | null | undefined;

export function tmpl(strings: TemplateStringsArray, ...values: Plain[]): string;
export function tmpl(strings: TemplateStringsArray, ...values: (Plain | Secret)[]): Secret;
export function tmpl(strings: TemplateStringsArray, ...values: unknown[]): string | Secret;
export function tmpl(strings: TemplateStringsArray, ...values: unknown[]): string | Secret {
  const secrets = values.filter(isSecret);
  let s = strings.reduce((acc, str, i) => {
    if (i >= values.length) return acc + str;
    const v = values[i];
    return acc + str + (isSecret(v) ? revealText(v) : String(v));
  }, "");
  s = s.replace(/^[ \t]*\n/, "").replace(/\n[ \t]*$/, "\n");
  const indents = s.split("\n").filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)![0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  if (min) s = s.split("\n").map((l) => l.slice(min)).join("\n");
  return secrets.length ? new Secret(`tmpl(${[...new Set(secrets.map((x) => x.name))].join(", ")})`, new TextEncoder().encode(s)) : s;
}

const SRC_DIR = dirname(import.meta.dir);

function callSite(repo: string): string {
  const stack = new Error().stack?.split("\n") ?? [];
  for (const line of stack.slice(1)) {
    const m = line.match(/\(?((?:\/|[A-Za-z]:)[^()]*?):(\d+):\d+\)?\s*$/);
    if (!m) continue;
    const file = m[1]!;
    if (file.startsWith(SRC_DIR + "/") || file.startsWith("/$bunfs") || file.includes("/node_modules/rig/")) continue;
    return `${file.startsWith(repo + "/") ? relative(repo, file) : file}:${m[2]}`;
  }
  return "<unknown>";
}

export interface EvalEnv {
  facts: Facts;
  repo: string;
  hostName: string;
  user?: string;
  email?: string;
  vars?: Record<string, unknown>;
  /** Prefix for built-in system paths (/etc/sysctl.d, boot loader config, …); tests point it at a temp dir. */
  root?: string;
  /**
   * Plaintext of a secret by name; throws if unavailable. Without it, secrets evaluate to
   * empty placeholders and are only recorded in graph.secrets (first pass, before decrypting).
   */
  secrets?: (name: string) => Uint8Array;
  /** Plugin resource types (defineConfig({ types })). */
  types?: readonly ResourceType[];
  /**
   * Where the machine should see the repo, when evaluating a different checkout of it (rig rollback
   * evaluates an old commit in a temporary worktree): link targets and command working directories
   * point here; file contents are still read from `repo`.
   */
  liveRepo?: string;
}

const BOOT: Record<string, { conf: string; line: (params: string) => string; regenerate: string }> = {
  // /etc/default/limine and /etc/default/grub are sourced by shell, so an appended assignment extends the cmdline.
  limine: { conf: "/etc/default/limine", line: (p) => `KERNEL_CMDLINE[default]+=" ${p}"`, regenerate: "limine-update" },
  grub: {
    conf: "/etc/default/grub",
    line: (p) => `GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT ${p}"`,
    regenerate: "grub-mkconfig -o /boot/grub/grub.cfg",
  },
};

/** Packages that should re-run the boot loader trigger (new kernels / modules). */
const KERNEL_PKG = /^pkg:(pacman|aur):(linux-cachyos.*|linux|linux-lts|linux-zen|.*-dkms)$/;

/** Run a host's modules and collect the declared resources. Nothing is executed. */
export function evaluate(hostDef: HostDef, env: EvalEnv): Graph {
  const g = new Graph();
  const { facts, repo } = env;
  const home = facts.user.home;
  const stack: string[] = [];
  const prov = (): Provenance => ({ modules: [...stack], site: callSite(repo) });
  const sysPath = (p: string) => (env.root ? join(env.root, p) : p);
  const primary = env.user ?? facts.user.name;

  // Mergeable sugar is collected while modules run and turned into resources afterwards.
  const sysctls = new Map<string, { value: string; prov: Provenance }>();
  const kparams: { params: string[]; prov: Provenance; regenerate?: string }[] = [];
  const unitFiles = new Map<string, string[]>(); // unit id → unit file IDs
  const restarts: { unit: string; on: string[]; user: boolean; prov: Provenance }[] = [];

  const addTrigger = (cmd: string, on: string[], scope: "user" | "system", p: Provenance = prov()) =>
    g.add(triggerType, { cmd, on, scope, cwd } satisfies TriggerSpec, p);

  const unitName = (n: string) => (/\.[a-z]+$/.test(n) ? n : `${n}.service`);
  const unitId = (name: string, user: boolean) => `unit:${user ? "user" : "system"}:${name}`;

  // Every builder records errors instead of throwing, so one bad line doesn't hide the rest.
  function guard<T>(fallback: T, fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      const p = prov();
      g.errors.push(`${errMsg(e)} (${stack.join(" > ") || "<host>"} at ${p.site})`);
      return fallback;
    }
  }

  const kinds = new Map([...builtinTypes, ...(env.types ?? [])].map((t) => [t.kind, t]));

  /** A repo path as the machine sees it (see EvalEnv.liveRepo). */
  const live = (p: string) => (env.liveRepo && isUnder(p, repo) ? join(env.liveRepo, relative(repo, p)) : p);
  const cwd = live(repo);

  /** Remember repo files evaluation depends on, so a remote bundle can carry them. */
  const asset = (p: string) => {
    if (isUnder(p, repo)) g.assets.add(p);
    return p;
  };

  const resolvePkg = (n: PkgName): string => {
    const family = facts.os.family;
    if (typeof n === "string") return family === "debian" ? (ALIASES[n]?.debian ?? n) : n;
    const v = family === "arch" || family === "debian" ? n[family] : undefined;
    if (!v) throw new Error(`no ${family} name for package ${JSON.stringify(n)}`);
    return v;
  };

  const addLink = (path: string, source: string, after?: string[]): string => {
    const p = targetPath(path, home);
    const target = asset(repoPath(source, repo, home));
    if (!existsSync(target)) throw new Error(`link source does not exist: ${source}`);
    const t = live(target);
    if (t !== target && !existsSync(t)) g.warnings.push(`${tilde(p, home)} will link to ${t}, which doesn't exist in your working copy`);
    return g.add(linkType, { path: p, target: t, scope: scopeOf(p, home), after }, prov());
  };

  const link: LinkFn = Object.assign((path: string, source: string, opts: Deps = {}) => guard("", () => addLink(path, source, opts.after)), {
    tree: (source: string, dest: string, opts: LinkTreeOptions = {}) =>
      guard([] as string[], () => {
        const root = repoPath(source, repo, home);
        // The whole tree, ignored entries included: on a remote host the walk below runs again and must see the same files.
        asset(root);
        const ignore = (opts.ignore ?? []).map((p) => new Bun.Glob(p));
        const skip = (rel: string) => ignore.some((gl) => gl.match(rel));
        const ids: string[] = [];
        const walk = (rel: string) => {
          for (const ent of readdirSync(join(root, rel), { withFileTypes: true })) {
            const r = rel ? `${rel}/${ent.name}` : ent.name;
            if (skip(r)) continue;
            const isDir = ent.isDirectory() || (ent.isSymbolicLink() && statSync(join(root, r)).isDirectory());
            if (isDir && opts.granularity !== "dir") walk(r);
            else ids.push(addLink(join(dest, r), join(root, r)));
          }
        };
        walk("");
        return ids;
      }),
  });

  const distroPkgType = () => {
    const type = facts.os.family === "arch" ? pacmanType : facts.os.family === "debian" ? aptType : null;
    if (!type) throw new Error(`no package backend for ${facts.os.name}`);
    return type;
  };

  const pkg: PkgFn = Object.assign(
    (names: PkgName | PkgName[], opts: Deps = {}) =>
      guard([] as string[], () => {
        const type = distroPkgType();
        return (Array.isArray(names) ? names : [names]).map((n) => g.add(type, { name: resolvePkg(n), after: opts.after }, prov()));
      }),
    {
      aur: (names: string | string[], opts: Deps = {}) =>
        guard([] as string[], () => {
          if (facts.os.family !== "arch") throw new Error(`AUR packages need an Arch-based host, not ${facts.os.name}`);
          const p = prov();
          const baseDevel = g.add(pacmanType, { name: "base-devel" }, p);
          return (Array.isArray(names) ? names : [names]).map((n) => g.add(aurType, { name: n, after: [baseDevel, ...(opts.after ?? [])] }, p));
        }),
      repo: (name: string, options: RepoOptions | AptRepoOptions) =>
        guard("", () => {
          if (facts.os.family === "debian") return aptRepo(name, options as AptRepoOptions);
          if (facts.os.family !== "arch") throw new Error(`no package repositories for ${facts.os.name}`);
          const opts = options as RepoOptions;
          if (!opts.include && !opts.server) throw new Error(`repo ${name}: needs include or server`);
          const servers = opts.server === undefined ? [] : Array.isArray(opts.server) ? opts.server : [opts.server];
          const body = [
            ...(opts.sigLevel ? [`SigLevel = ${opts.sigLevel}`] : []),
            ...(opts.include ? [`Include = ${opts.include}`] : []),
            ...servers.map((s) => `Server = ${s}`),
          ];
          const conf = opts.conf ? targetPath(opts.conf, home) : sysPath("/etc/pacman.conf");
          return g.add(repoType, { name, conf, body, position: opts.position ?? "last", keys: opts.keys ?? [], keyserver: opts.keyserver, after: opts.after }, prov());
        }),
      flatpak: (apps: string | string[], opts: FlatpakOptions = {}) =>
        guard([] as string[], () => {
          const list = Array.isArray(apps) ? apps : [apps];
          for (const a of list) if (!isAppId(a)) throw new Error(`flatpak app IDs are reverse-DNS names like org.mozilla.firefox, not "${a}"`);
          const p = prov();
          const flatpak = g.add(distroPkgType(), { name: "flatpak" }, p);
          const remote = opts.remote ?? FLATHUB.name;
          return list.map((app) =>
            g.add(flatpakType, { app, remote, ...(opts.url ? { url: opts.url } : {}), after: [flatpak, ...(opts.after ?? [])] } satisfies FlatpakSpec, p),
          );
        }),
    },
  );

  const aptRepo = (name: string, opts: AptRepoOptions): string => {
    if (!/^[\w.-]+$/.test(name)) throw new Error(`apt repo name must be a plain file name: ${name}`);
    if (!("uris" in opts) || !opts.uris) throw new Error(`apt repo ${name}: needs uris (pacman-style options don't apply on Debian)`);
    const list = (v: string | string[] | undefined, dflt: string[]) => (v === undefined ? dflt : Array.isArray(v) ? v : [v]);
    const suites = list(opts.suites, facts.os.codename ? [facts.os.codename] : []);
    if (!suites.length) throw new Error(`apt repo ${name}: no suites given and the release codename is unknown`);
    const body = [
      `Types: ${(opts.types ?? ["deb"]).join(" ")}`,
      `URIs: ${list(opts.uris, []).join(" ")}`,
      `Suites: ${suites.join(" ")}`,
      `Components: ${list(opts.components, ["main"]).join(" ")}`,
      ...(opts.architectures?.length ? [`Architectures: ${opts.architectures.join(" ")}`] : []),
    ];
    const p = prov();
    const after = [...(opts.after ?? [])];
    if (opts.key) {
      const inline = opts.key.includes("-----BEGIN PGP PUBLIC KEY BLOCK-----");
      const data = inline ? new TextEncoder().encode(opts.key) : new Uint8Array(readFileSync(asset(repoPath(opts.key, repo, home))));
      const armored = new TextDecoder().decode(data.subarray(0, 64)).includes("-----BEGIN PGP");
      const keyPath = sysPath(`/etc/apt/keyrings/${name}.${armored ? "asc" : "gpg"}`);
      after.push(g.add(fileType, { path: keyPath, data, hash: xxh(data), mode: 0o644, scope: scopeOf(keyPath, home) } satisfies FileSpec, p));
      body.push(`Signed-By: ${keyPath}`);
    }
    const path = sysPath(`/etc/apt/sources.list.d/${name}.sources`);
    const data = new TextEncoder().encode(`# Managed by rig.\n${body.join("\n")}\n`);
    return g.add(fileType, { path, data, hash: xxh(data), mode: 0o644, scope: scopeOf(path, home), after: after.length ? after : undefined } satisfies FileSpec, p);
  };

  const addMember = (user: string, group: string, after?: string[]) => g.add(memberType, { user, group, after }, prov());

  const user: UserFn = Object.defineProperties(
    (name: string, opts: AccountOptions = {}) =>
      guard("", () => {
        const id = g.add(userType, { name, system: opts.system, uid: opts.uid, home: opts.home, shell: opts.shell, prune: opts.prune, after: opts.after }, prov());
        for (const gr of opts.groups ?? []) addMember(name, gr, [id]);
        return id;
      }),
    {
      name: { value: primary, enumerable: true },
      home: { value: home, enumerable: true },
      email: { value: env.email, enumerable: true },
      groups: { value: (groups: string[], opts: Deps = {}) => guard([] as string[], () => groups.map((gr) => addMember(primary, gr, opts.after))), enumerable: true },
    },
  ) as UserFn;

  const unit: UnitFn = Object.assign(
    (name: string, opts: UnitOptions = {}) =>
      guard("", () => {
        const n = unitName(name);
        const isUser = opts.user ?? false;
        const spec: UnitSpec = { name: n, user: isUser, enabled: opts.enabled ?? true, started: opts.started, scope: isUser ? "user" : "system", after: opts.after };
        const p = prov();
        const id = g.add(unitType, spec, p);
        if (opts.restartOn?.length) restarts.push({ unit: n, on: opts.restartOn, user: isUser, prov: p });
        return id;
      }),
    {
      define: (name: string, content: string, opts: Deps & { user?: boolean; dropIn?: string } = {}) =>
        guard("", () => {
          const n = unitName(name);
          const isUser = opts.user ?? false;
          const dir = isUser ? join(home, ".config/systemd/user") : sysPath("/etc/systemd/system");
          const path = opts.dropIn ? join(dir, `${n}.d`, `${opts.dropIn.replace(/\.conf$/, "")}.conf`) : join(dir, n);
          const data = new TextEncoder().encode(content);
          const p = prov();
          const fid = g.add(fileType, { path, data, hash: xxh(data), scope: scopeOf(path, home), after: opts.after } satisfies FileSpec, p);
          addTrigger(isUser ? "systemctl --user daemon-reload" : "systemctl daemon-reload", [fid], isUser ? "user" : "system", p);
          const uid = unitId(n, isUser);
          (unitFiles.get(uid) ?? unitFiles.set(uid, []).get(uid)!).push(fid);
          return fid;
        }),
    },
  );

  const sysctlId = `file:${sysPath("/etc/sysctl.d/90-rig.conf")}`;
  const bootLineId = () => {
    const b = BOOT[facts.boot.loader];
    return b ? `line:${sysPath(b.conf)}#kernelParams` : "";
  };

  const ctx: Ctx = {
    facts,
    host: env.hostName,
    repo,
    user,
    vars: env.vars ?? {},
    tmpl,
    link,
    pkg,
    unit,

    file: (path, content, opts = {}) =>
      guard("", () => {
        const o: FileOptions = typeof content === "string" || content instanceof Uint8Array || isSecret(content) ? { ...opts, content } : { ...content, ...opts };
        const p = targetPath(path, home);
        let data: Uint8Array;
        const secret = isSecret(o.content);
        if (o.source !== undefined) data = new Uint8Array(readFileSync(asset(repoPath(o.source, repo, home))));
        else if (isSecret(o.content)) data = reveal(o.content);
        else if (o.content !== undefined) data = typeof o.content === "string" ? new TextEncoder().encode(o.content) : o.content;
        else throw new Error(`file ${path}: needs content or source`);
        const spec: FileSpec = { path: p, data, hash: xxh(data), mode: o.mode ?? (secret ? 0o600 : undefined), scope: scopeOf(p, home), after: o.after };
        if (secret) spec.secret = true;
        return g.add(fileType, spec, prov());
      }),

    dir: (path, opts = {}) =>
      guard("", () => {
        const p = targetPath(path, home);
        return g.add(dirType, { path: p, mode: opts.mode, scope: scopeOf(p, home), after: opts.after }, prov());
      }),

    exec: (cmd, opts = {}) =>
      guard("", () => {
        const spec = {
          cmd,
          unless: opts.unless,
          creates: opts.creates ? targetPath(opts.creates, home) : undefined,
          onChange: opts.onChange,
          undo: opts.undo,
          after: opts.after,
          scope: opts.asUser ? ("user" as const) : ("system" as const),
          cwd,
        };
        const p = prov();
        if (!spec.unless && !spec.creates && !spec.onChange?.length)
          g.warnings.push(`exec "${cmd}" has no unless/creates/onChange guard and will run on every apply (${p.site})`);
        return g.add(execType, spec, p);
      }),

    group: (name, opts = {}) => guard("", () => g.add(groupType, { name, system: opts.system, gid: opts.gid, prune: opts.prune, after: opts.after }, prov())),

    sysctl: (values) =>
      guard("", () => {
        const p = prov();
        for (const [k, v] of Object.entries(values)) {
          const prev = sysctls.get(k);
          if (prev && prev.value !== String(v))
            throw new Error(`sysctl ${k} = ${v} conflicts with ${prev.value} from ${fmtProv(prev.prov)}`);
          if (!prev) sysctls.set(k, { value: String(v), prov: p });
        }
        return sysctlId;
      }),

    lineInFile: (path, line) =>
      guard("", () => {
        const p = targetPath(path, home);
        const o: LineOptions | BlockOptions = typeof line === "string" ? { line } : line;
        const spec: LineSpec =
          "block" in o
            ? { path: p, key: o.key, text: o.block.replace(/\n$/, ""), block: true, comment: o.comment ?? "#", scope: scopeOf(p, home), after: o.after }
            : { path: p, key: o.key ?? o.match?.source ?? o.line, text: o.line, block: false, match: o.match?.source, comment: "#", scope: scopeOf(p, home), after: o.after };
        if (!spec.key) throw new Error(`lineInFile ${path}: needs a key`);
        if (!spec.block && spec.text.includes("\n")) throw new Error(`lineInFile ${path}: line contains a newline; use { block, key }`);
        return g.add(lineType, spec, prov());
      }),

    secret: (name) =>
      guard(new Secret(name, new Uint8Array()), () => {
        checkName(name);
        g.secrets.add(name);
        return new Secret(name, env.secrets ? env.secrets(name) : new Uint8Array());
      }),

    trigger: (cmd, opts) => guard("", () => addTrigger(cmd, opts.on, opts.asUser ? "user" : "system")),

    kernelParams: (params, opts = {}) =>
      guard("", () => {
        if (!BOOT[facts.boot.loader]) throw new Error(`kernelParams: unsupported boot loader "${facts.boot.loader}" (supported: limine, grub)`);
        kparams.push({ params, prov: prov(), regenerate: opts.regenerate });
        return bootLineId();
      }),

    kconfig: (file, groups, opts = {}) =>
      guard([] as string[], () => {
        const path = file.startsWith("~") || file.startsWith("/") ? targetPath(file, home) : join(home, ".config", file);
        const p = prov();
        const ids: string[] = [];
        for (const [group, keys] of Object.entries(groups)) {
          const groupPath = group.split("][");
          if (groupPath.some((x) => !x)) throw new Error(`kconfig ${file}: empty group name in "${group}"`);
          for (const [key, v] of Object.entries(keys)) {
            if (!key || /[=\n\[]/.test(key)) throw new Error(`kconfig ${file} [${group}]: invalid key "${key}"`);
            const spec: KconfigSpec = { path, group: groupPath, key, value: String(v), scope: scopeOf(path, home), after: opts.after };
            if (typeof v === "boolean") spec.bool = true;
            ids.push(g.add(kconfigType, spec, p));
          }
        }
        return ids;
      }),

    git: (path, url, opts = {}) =>
      guard("", () => {
        if (!url) throw new Error(`git ${path}: needs a URL`);
        const p = targetPath(path, home);
        return g.add(gitType, { path: p, url, ref: opts.ref, prune: opts.prune, scope: scopeOf(p, home), after: opts.after } satisfies GitSpec, prov());
      }),

    resource: (type, spec, opts = {}) =>
      guard("", () => {
        const registered = kinds.get(type?.kind);
        if (registered !== type)
          throw new Error(
            registered
              ? `resource(): this "${type.kind}" type is not the one registered under that kind`
              : `resource type "${type?.kind}" is not registered — add it to defineConfig({ types: [...] })`,
          );
        const id = type.id(spec);
        if (!id.startsWith(type.kind + ":")) throw new Error(`resource type "${type.kind}" produced the ID "${id}"; IDs must start with "${type.kind}:"`);
        return g.add(type, opts.after ? { ...spec, after: [...(spec.after ?? []), ...opts.after] } : spec, prov());
      }),

    include: (...mods) => {
      for (const m of mods) runModule(m);
    },
  };

  function runModule(ref: ModuleRef) {
    const inst = guard(null, () => toInstance(ref));
    if (!inst) return;
    stack.push(inst.name);
    try {
      inst.run(ctx);
    } catch (e) {
      g.errors.push(`module ${stack.join(" > ")} threw: ${errMsg(e)}`);
    } finally {
      stack.pop();
    }
  }

  for (const m of hostDef.modules) runModule(m);

  // --- post-pass: turn collected sugar into resources -----------------------
  const post = <T>(p: Provenance, fn: () => T) => {
    try {
      return fn();
    } catch (e) {
      g.errors.push(`${errMsg(e)} (${fmtProv(p)})`);
    }
  };

  if (sysctls.size) {
    const first = [...sysctls.values()][0]!.prov;
    post(first, () => {
      const keys = [...sysctls.keys()].sort();
      const data = new TextEncoder().encode(`# Managed by rig — merged from sysctl() calls.\n${keys.map((k) => `${k} = ${sysctls.get(k)!.value}`).join("\n")}\n`);
      const path = sysPath("/etc/sysctl.d/90-rig.conf");
      const id = g.add(fileType, { path, data, hash: xxh(data), scope: scopeOf(path, home) } satisfies FileSpec, first);
      const decl = g.decls.get(id)!;
      for (const s of new Set([...sysctls.values()].map((v) => v.prov)).values()) if (s !== first) decl.provenance.push(s);
      addTrigger("sysctl --system", [id], "system", first);
    });
  }

  if (kparams.length) {
    const first = kparams[0]!.prov;
    post(first, () => {
      const b = BOOT[facts.boot.loader]!;
      const params = [...new Set(kparams.flatMap((k) => k.params))];
      // Debian's GRUB lives at /boot/grub too, but update-grub is the distro's documented entry point.
      const fallback = facts.os.family === "debian" && facts.boot.loader === "grub" ? "update-grub" : b.regenerate;
      const regenerate = kparams.find((k) => k.regenerate)?.regenerate ?? fallback;
      const path = sysPath(b.conf);
      const id = g.add(lineType, { path, key: "kernelParams", text: b.line(params.join(" ")), block: true, comment: "#", scope: scopeOf(path, home) } satisfies LineSpec, first);
      for (const k of kparams.slice(1)) g.decls.get(id)!.provenance.push(k.prov);
      // New kernels and DKMS modules also need fresh boot entries.
      const kernels = [...g.decls.keys()].filter((k) => KERNEL_PKG.test(k));
      addTrigger(regenerate, [id, ...kernels], "system", first);
    });
  }

  // Units come after their unit files (and reload systemd first when those changed).
  for (const [uid, files] of unitFiles) {
    const d = g.decls.get(uid);
    if (!d) continue;
    d.spec = { ...d.spec, after: [...new Set([...(d.spec.after ?? []), ...files])], reloadOn: files } satisfies UnitSpec;
  }
  for (const r of restarts) post(r.prov, () => addTrigger(`systemctl ${r.user ? "--user " : ""}try-restart ${r.unit}`, r.on, r.user ? "user" : "system", r.prov));

  // apt packages may come from a source declared in this run: write sources (and keys) first.
  const aptSources = [...g.decls.keys()].filter(isAptSource);
  if (aptSources.length)
    for (const d of g.decls.values()) if (d.type === aptType) d.spec = { ...d.spec, after: [...new Set([...(d.spec.after ?? []), ...aptSources])] };

  // Checkouts need git itself, when the config installs it.
  const gitPkg = ["pkg:pacman:git", "pkg:apt:git"].find((id) => g.decls.has(id));
  if (gitPkg) for (const d of g.decls.values()) if (d.type === gitType) d.spec = { ...d.spec, after: [...new Set([...(d.spec.after ?? []), gitPkg])] };

  // Memberships come after the account and group they refer to, when those are declared.
  for (const d of g.decls.values()) {
    if (d.type !== memberType) continue;
    const deps = [`group:${d.spec.group}`, `user:${d.spec.user}`].filter((id) => g.decls.has(id));
    if (deps.length) d.spec = { ...d.spec, after: [...new Set([...(d.spec.after ?? []), ...deps])] };
  }
  return g;
}
