import type { Executors, Facts, Scope } from "./types.ts";
import { gatherFacts } from "./facts/index.ts";
import { homedir } from "node:os";
import { relative } from "node:path";
import { CONFIG_FILE, findConfigDir, loadConfig } from "./config/load.ts";
import { resolveHost, type ConfigDef, type HostDef } from "./config/define.ts";
import { evaluate } from "./config/context.ts";
import { makePlan, type Plan } from "./plan/plan.ts";
import { checkTypes, typeRegistry, type TypeRegistry } from "./resources/index.ts";
import { StateStore, defaultStateDir } from "./state/state.ts";
import { UserExecutor, spawn } from "./exec/local.ts";
import { systemExecutor } from "./exec/helper.ts";
import type { Decl, Graph } from "./graph/graph.ts";
import { SecretStore } from "./secrets/store.ts";
import { OfflineExecutor, type Fixture } from "./facts/fixture.ts";
import { errMsg } from "./resources/util.ts";

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
  }
}

export interface EngineOptions {
  configDir?: string;
  host?: string;
  force?: boolean;
  /** Only user-scoped resources (rig dot). */
  userOnly?: boolean;
  /** Glob over resource IDs or module names (--only). */
  only?: string;
  /** Skip checks that need subprocesses (package-name validation). */
  fast?: boolean;
  /** Exact package mode: mark undeclared packages as dependencies instead of removing them. */
  demote?: boolean;
  facts?: Facts;
  x?: Executors;
  stateDir?: string;
  /** Config entry inside configDir (a remote run loads the bundled config). */
  configFile?: string;
  /** Running on the target of a remote apply: don't redirect to SSH, never prompt for sudo. */
  onTarget?: boolean;
  /** Secret plaintexts sent along with a remote bundle; otherwise secrets are decrypted from the repo. */
  secrets?: (name: string) => Uint8Array;
  /** configDir is another checkout of this repo (rig rollback): links and commands point here instead. */
  liveRepo?: string;
}

/** The selected host, before anything is evaluated. */
export interface Target {
  repo: string;
  config: ConfigDef;
  hostName: string;
  hostDef: HostDef;
  /** Facts of the machine running rig. */
  facts: Facts;
}

export interface Prepared extends Target {
  graph: Graph;
  order: string[];
  types: TypeRegistry;
  x: Executors;
  state: StateStore;
}

export async function loadTarget(opts: EngineOptions): Promise<Target> {
  const facts = opts.facts ?? gatherFacts();
  const repo = opts.configFile ? opts.configDir! : findConfigDir(opts.configDir, facts.user.home);
  const config = await loadConfig(repo, opts.configFile ?? CONFIG_FILE);
  const names = Object.keys(config.hosts);
  const hostName = opts.host ?? facts.hostname;
  const entry = config.hosts[hostName];
  if (!entry)
    throw new ConfigError([
      opts.host
        ? `unknown host "${hostName}" (configured: ${names.join(", ") || "none"})`
        : `no host named after this machine ("${hostName}") — pass one of: ${names.join(", ") || "none"}`,
    ]);
  return { repo, config, hostName, hostDef: await resolveHost(entry), facts };
}

/** A host with `connect` is applied over SSH, unless rig already runs on it. */
export const isRemote = (t: Target, opts: EngineOptions = {}) => !!t.hostDef.connect && !opts.onTarget && t.hostName !== t.facts.hostname;

/** Run the host's modules against `facts` (which may be another machine's). */
export function evaluateHost(t: Omit<Target, "facts">, facts: Facts, secrets?: (name: string) => Uint8Array, liveRepo?: string): Graph {
  const problems = checkTypes(t.config.types ?? []);
  if (problems.length) throw new ConfigError(problems);
  return evaluate(t.hostDef, {
    facts,
    repo: t.repo,
    hostName: t.hostName,
    user: t.config.defaults?.user,
    email: t.config.defaults?.email,
    vars: t.config.defaults?.vars,
    secrets,
    types: t.config.types,
    liveRepo,
  });
}

/** Decrypt the named secrets with the invoking user's keys (always local, even for remote hosts). */
export async function decryptSecrets(repo: string, names: Iterable<string>): Promise<Map<string, Uint8Array>> {
  const store = new SecretStore(repo, process.env.HOME || homedir());
  const out = new Map<string, Uint8Array>();
  const problems: string[] = [];
  for (const n of names) {
    try {
      out.set(n, await store.decrypt(n));
    } catch (e) {
      problems.push(errMsg(e));
    }
  }
  if (problems.length) throw new ConfigError(problems);
  return out;
}

export async function prepare(opts: EngineOptions): Promise<Prepared> {
  const t = await loadTarget(opts);
  const { repo, hostName, hostDef, facts } = t;
  if (isRemote(t, opts)) throw new ConfigError([`host ${hostName} is remote (connect: ${hostDef.connect!.ssh}); it is applied over SSH`]);
  if (hostDef.os !== facts.os.family) throw new ConfigError([`host ${hostName} is declared os: "${hostDef.os}" but this machine is ${facts.os.name} (${facts.os.family})`]);

  // Secrets are only decrypted when the config asks for them: a first pass records their names.
  let graph = evaluateHost(t, facts, opts.secrets, opts.liveRepo);
  if (!opts.secrets && graph.secrets.size && !graph.errors.length) {
    const values = await decryptSecrets(repo, graph.secrets);
    graph = evaluateHost(t, facts, (n) => values.get(n)!, opts.liveRepo);
  }
  const order = graph.finalize();
  if (graph.errors.length) throw new ConfigError(graph.errors);

  const types = typeRegistry(t.config.types ?? []);
  const x = opts.x ?? { user: new UserExecutor(), system: systemExecutor(opts.onTarget) };
  if (!opts.fast) {
    const errs = await validate(graph, types, { facts, x });
    if (errs.length) throw new ConfigError(errs);
  }

  // Seen from the machine, the repo is the live one (paths in plan output, apply context).
  return { ...t, repo: opts.liveRepo ?? repo, graph, order, types, x, state: new StateStore(opts.stateDir ?? defaultStateDir(facts.user.home)) };
}

/** Run every resource type's validate() over its declarations. */
async function validate(graph: Graph, types: TypeRegistry, ctx: { facts: Facts; x: Executors; offline?: boolean; skip?: (kind: string) => boolean }): Promise<string[]> {
  const ids = new Set(graph.decls.keys());
  const byKind = new Map<string, unknown[]>();
  for (const d of graph.decls.values()) (byKind.get(d.type.kind) ?? byKind.set(d.type.kind, []).get(d.type.kind)!).push(d.spec);
  const errs = await Promise.all(
    [...byKind].filter(([k]) => !ctx.skip?.(k)).map(([k, specs]) => types.get(k).validate?.(specs as any[], { facts: ctx.facts, x: ctx.x, ids, offline: ctx.offline }) ?? []),
  );
  return errs.flat();
}

export interface OfflineCheck extends Target {
  graph: Graph;
  order: string[];
  warnings: string[];
}

/**
 * `rig plan --offline`: evaluate and validate a host against fixture facts, without touching
 * any machine and without decrypting secrets (CI has no keys). Throws ConfigError on problems.
 */
export async function checkOffline(opts: EngineOptions & { fixture: Fixture }): Promise<OfflineCheck> {
  const facts = opts.fixture.facts;
  const t = await loadTarget({ ...opts, host: opts.host ?? opts.fixture.host ?? facts.hostname, facts });
  if (t.hostDef.os !== facts.os.family) throw new ConfigError([`host ${t.hostName} is declared os: "${t.hostDef.os}" but the facts are from ${facts.os.name} (${facts.os.family})`]);
  const graph = evaluateHost(t, facts);
  const order = graph.finalize();
  const warnings: string[] = [];
  // Secrets can't be decrypted here, but they have to exist.
  const store = new SecretStore(t.repo, facts.user.home);
  for (const name of graph.secrets)
    if (!(await Bun.file(store.path(name)).exists())) warnings.push(`secret "${name}": ${relative(t.repo, store.path(name))} doesn't exist yet (rig secret edit ${name})`);
  if (graph.errors.length) throw new ConfigError(graph.errors);

  const index = opts.fixture.packages;
  const offline = new OfflineExecutor(index);
  const usesPkgs = [...graph.decls.values()].some((d) => d.type.kind.startsWith("pkg:") && d.type.kind !== "pkg:flatpak");
  if (usesPkgs && !index) warnings.push("package names not checked: the fixture has no package list (rig facts --save adds one)");
  const errs = await validate(graph, typeRegistry(t.config.types ?? []), {
    facts,
    x: { user: offline, system: offline },
    offline: true,
    skip: (k) => !index && k.startsWith("pkg:"),
  });
  if (errs.length) throw new ConfigError(errs);
  return { ...t, graph, order, warnings: [...graph.warnings, ...warnings] };
}

export function makeFilter(opts: Pick<EngineOptions, "userOnly" | "only">) {
  const glob = opts.only ? new Bun.Glob(opts.only) : null;
  return ({ id, scope, decl }: { id: string; scope: Scope; decl?: Decl }) => {
    if (opts.userOnly && scope !== "user") return false;
    if (glob && !glob.match(id) && !decl?.provenance.some((p) => p.modules.some((m) => glob.match(m)))) return false;
    return true;
  };
}

export async function plan(p: Prepared, opts: EngineOptions): Promise<Plan> {
  return makePlan({
    host: p.hostName,
    facts: p.facts,
    graph: p.graph,
    order: p.order,
    prev: await p.state.latest(p.hostName),
    types: p.types,
    x: p.x,
    repo: p.repo,
    force: opts.force,
    filter: makeFilter(opts),
    exact: p.hostDef.packages?.mode === "exact" ? { keep: ["base", ...(p.hostDef.packages.keep ?? [])], demote: opts.demote ?? false } : undefined,
  });
}

export async function closeExecutors(x: Executors) {
  await Promise.all([x.user.close?.(), x.system.close?.()]);
}

export async function gitCommit(repo: string): Promise<string | null> {
  try {
    const r = await spawn(["git", "-C", repo, "rev-parse", "--short", "HEAD"]);
    if (r.code !== 0) return null;
    const dirty = (await spawn(["git", "-C", repo, "status", "--porcelain"])).stdout.trim() !== "";
    return r.stdout.trim() + (dirty ? "-dirty" : "");
  } catch {
    return null;
  }
}
