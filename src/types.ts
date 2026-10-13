// Shared types for the rig engine.

export type Scope = "user" | "system";

/** Where a resource was declared: module chain + "file:line" relative to the repo. */
export interface Provenance {
  modules: string[];
  site: string;
}

// ---------------------------------------------------------------------------
// Facts

export interface Facts {
  hostname: string;
  os: {
    family: "arch" | "debian" | "unknown";
    id: string;
    idLike: string[];
    name: string;
    version: string;
    /** Release codename (VERSION_CODENAME), e.g. "trixie"; empty on rolling distros. */
    codename: string;
  };
  arch: string;
  cpu: { vendor: string; model: string; level: "x86-64" | "x86-64-v2" | "x86-64-v3" | "x86-64-v4" | "unknown" };
  gpu: { vendor: "nvidia" | "amd" | "intel" | "none"; all: string[] };
  rootfs: string;
  init: "systemd" | "unknown";
  user: { name: string; uid: number; home: string };
  users: { name: string; uid: number; home: string; shell: string }[];
  boot: { loader: "limine" | "grub" | "systemd-boot" | "unknown" };
}

// ---------------------------------------------------------------------------
// Executor

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | Uint8Array;
  /** Pass the child's stdout/stderr through to the terminal instead of capturing it. */
  stream?: boolean;
}

export type StatType = "file" | "dir" | "symlink" | "other";

export interface Stat {
  type: StatType;
  mode: number; // permission bits only
}

/**
 * Everything a resource may do to a machine goes through an Executor, so the
 * same resource code works unprivileged, via sudo, or against a fake in tests.
 */
export interface Executor {
  readonly privileged: boolean;
  run(argv: string[], opts?: RunOptions): Promise<RunResult>;
  readFile(path: string): Promise<Uint8Array | null>;
  /** Atomic write (tmp + rename); creates parent directories. */
  writeFile(path: string, data: Uint8Array, mode: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<Stat | null>;
  readlink(path: string): Promise<string | null>;
  /** Atomically create or replace a symlink at `path` pointing to `target`. */
  symlink(target: string, path: string): Promise<void>;
  mkdirp(path: string, mode?: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Remove a file or symlink (never recursive). */
  unlink(path: string): Promise<void>;
  /** Remove an empty directory; returns false if it was not empty. */
  rmdir(path: string): Promise<boolean>;
  /** Release resources (e.g. stop the privileged helper). */
  close?(): Promise<void>;
}

export interface Executors {
  user: Executor;
  system: Executor;
}

export const pick = (x: Executors, scope: Scope): Executor => (scope === "user" ? x.user : x.system);

// ---------------------------------------------------------------------------
// Resources

export interface ResourceBase {
  /** Explicit dependencies (resource IDs). */
  after?: string[];
}

export type ChangeAction = "create" | "update" | "run";

export interface Change<Spec = unknown, Live = unknown, Meta = unknown> {
  id: string;
  action: ChangeAction;
  spec: Spec;
  live: Live | null;
  prevMeta: Meta | undefined;
  /** One-line note shown after the resource in plan output. */
  note?: string;
  /** Multi-line detail (e.g. unified diff). */
  detail?: string;
}

export type DiffResult<Meta = unknown> =
  | { op: "change"; action: ChangeAction; note?: string; detail?: string }
  | { op: "noop"; meta: Meta }
  | { op: "blocked"; reason: string };

export type DestroyPlan = { op: "destroy"; note?: string } | { op: "forget"; note?: string } | { op: "blocked"; reason: string };

export type Result<Meta = unknown> = { id: string; ok: true; meta: Meta; note?: string } | { id: string; ok: false; error: string };

export interface DiffContext {
  force: boolean;
  /** IDs that the plan will change before this resource (topologically earlier). */
  changed: ReadonlySet<string>;
  home: string;
  repo: string;
}

export interface ApplyContext {
  force: boolean;
  verbose: boolean;
  objects: ObjectStore;
  home: string;
  repo: string;
  /** The user rig runs as. */
  user: string;
  /** IDs that actually changed so far in this run. */
  changed: ReadonlySet<string>;
}

export interface ValidateContext {
  facts: Facts;
  x: Executors;
  /** Every declared resource ID (e.g. to see which pacman repos are declared). */
  ids: ReadonlySet<string>;
  /**
   * `rig plan --offline`: the machine isn't there. `x` only answers package-list queries from
   * the fixture; checks that need anything else should be skipped.
   */
  offline?: boolean;
}

/** A resource found on the machine that the config does not declare (exact package mode). */
export interface Extraneous {
  id: string;
  scope: Scope;
  meta: unknown;
  display: string;
}

export interface ExtraneousOptions {
  /** Declared resource IDs. */
  declared: ReadonlySet<string>;
  /** Names (globs) that are never considered extraneous. */
  keep: string[];
  /** Mark as dependency instead of removing. */
  demote: boolean;
}

export interface ResourceType<Spec extends ResourceBase = any, Live = any, Meta = any> {
  kind: string;
  /** Section heading in plan output. */
  label: string;
  /** Lower runs earlier within one topological level (packages before files, …). */
  order: number;
  scope(spec: Spec): Scope;
  id(spec: Spec): string;
  /** Human-readable name for a resource ID (spec may be absent for destroys). */
  display(id: string, spec: Spec | undefined, paths: { home: string; repo: string }): string;
  /** Specs considered equal for duplicate-ID merging. */
  equal(a: Spec, b: Spec): boolean;
  /** Union two declarations of the same ID (takes precedence over `equal`); a string is a conflict message. */
  merge?(a: Spec, b: Spec): Spec | string;
  edges?(spec: Spec): string[];
  /** Implicitly depend on packages declared by the same module (units, group memberships, …). */
  afterPackages?: boolean;
  /** Applied once at the very end of a run, after every other change (triggers). */
  deferred?: boolean;
  validate?(specs: Spec[], ctx: ValidateContext): Promise<string[]>;
  /** Batched read of live state. Spec is absent for resources only being destroyed; they carry their last meta instead. */
  read(items: { id: string; scope: Scope; spec?: Spec; meta?: Meta }[], x: Executors): Promise<Map<string, Live | null>>;
  diff(spec: Spec, live: Live | null, prev: Meta | undefined, ctx: DiffContext): DiffResult<Meta>;
  /** Batched apply. Must return one Result per change. */
  apply(changes: Change<Spec, Live, Meta>[], x: Executors, ctx: ApplyContext): Promise<Result<Meta>[]>;
  planDestroy?(id: string, meta: Meta, live: Live | null, ctx: DiffContext): DestroyPlan;
  destroy?(items: { id: string; scope: Scope; meta: Meta }[], x: Executors, ctx: ApplyContext): Promise<Result<null>[]>;
  /** Exact mode: live resources of this kind that are not declared and should be pruned. */
  extraneous?(opts: ExtraneousOptions, x: Executors): Promise<Extraneous[]>;
}

export interface ObjectStore {
  put(data: Uint8Array): Promise<string>;
  get(hash: string): Promise<Uint8Array | null>;
}
