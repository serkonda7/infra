import type { Ctx } from "./context.ts";
import type { SnapshotSetting } from "../apply/snapshot.ts";
import type { ResourceType } from "../types.ts";

const MODULE = Symbol.for("rig.module");
const FACTORY = Symbol.for("rig.moduleFactory");
const HOST = Symbol.for("rig.host");
const CONFIG = Symbol.for("rig.config");

export interface ModuleInstance {
  readonly [MODULE]: true;
  readonly name: string;
  readonly run: (ctx: Ctx) => void;
}

export interface ModuleFactory<O> {
  (opts?: O): ModuleInstance;
  readonly [FACTORY]: true;
  readonly moduleName: string;
}

export type ModuleRef = ModuleInstance | ModuleFactory<any>;

/**
 * Define a reusable module. The result can be used bare (`dev`) or called
 * with options (`gaming({ steam: true })`).
 */
export function module<O = undefined>(name: string, fn: (ctx: Ctx, opts: O) => void): ModuleFactory<O> {
  const factory = (opts?: O): ModuleInstance => ({ [MODULE]: true, name, run: (ctx) => fn(ctx, opts as O) });
  return Object.assign(factory, { [FACTORY]: true as const, moduleName: name });
}

export function toInstance(ref: ModuleRef): ModuleInstance {
  if ((ref as any)?.[MODULE]) return ref as ModuleInstance;
  if ((ref as any)?.[FACTORY]) return (ref as ModuleFactory<unknown>)();
  throw new Error(`not a module: ${String(ref)} (wrap it with module("name", ctx => …))`);
}

export interface HostDef {
  readonly [HOST]: true;
  /** Distro family. The concrete distro (e.g. CachyOS) is detected via facts. */
  os: "arch" | "debian";
  /**
   * "additive" (default) only removes packages rig installed. "exact" also removes every explicitly
   * installed package that isn't declared, except `base` and the `keep` globs.
   * `remove` globs (package names or Flatpak app IDs) are removed in either mode, even when they
   * were installed before rig; declared packages always win.
   */
  packages?: { mode?: "additive" | "exact"; keep?: string[]; remove?: string[] };
  /** Overrides defaults.snapshots for this host. */
  snapshots?: SnapshotSetting;
  /** Apply this host over SSH (agentless push) instead of locally. */
  connect?: {
    /** `user@host` (or a Host alias from ~/.ssh/config). */
    ssh: string;
    port?: number;
    /** "password": prompt locally when root is needed and pass it through. Default: try passwordless, then prompt. */
    sudo?: "password" | "nopasswd";
    /** Seconds before sshd/firewall/network changes are reverted unless a fresh SSH login works (default 120, 0 = off). */
    deadman?: number;
  };
  modules: ModuleRef[];
}

export function host(def: Omit<HostDef, typeof HOST>): HostDef {
  return { ...def, [HOST]: true };
}

export const isHost = (v: unknown): v is HostDef => !!(v as any)?.[HOST];

export type HostEntry = HostDef | (() => Promise<{ default: HostDef }> | { default: HostDef } | HostDef);

export interface ConfigDef {
  readonly [CONFIG]: true;
  hosts: Record<string, HostEntry>;
  /**
   * Custom resource types (plugins), used with ctx.resource(type, spec). They must stay
   * registered while a generation still owns resources of their kind, so rig can remove them.
   */
  types?: ResourceType<any, any, any>[];
  defaults?: {
    /** Primary user (defaults to whoever runs rig). */
    user?: string;
    email?: string;
    /** Free-form values exposed to modules as ctx.vars. */
    vars?: Record<string, unknown>;
    /** Snapshot the root filesystem around applies that touch the system (default "auto": snapper if set up). */
    snapshots?: SnapshotSetting;
  };
}

export function defineConfig(def: Omit<ConfigDef, typeof CONFIG>): ConfigDef {
  return { ...def, [CONFIG]: true };
}

export const isConfig = (v: unknown): v is ConfigDef => !!(v as any)?.[CONFIG];

export async function resolveHost(entry: HostEntry): Promise<HostDef> {
  if (isHost(entry)) return entry;
  const v = await entry();
  const h = isHost(v) ? v : (v as { default: HostDef }).default;
  if (!isHost(h)) throw new Error("host entry must resolve to a host({...}) default export");
  return h;
}
