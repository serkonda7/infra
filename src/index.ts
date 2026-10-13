// Public API used by config repos: `import { defineConfig, host, module } from "rig"`.
export { defineConfig, host, module } from "./config/define.ts";
export type { ConfigDef, HostDef, ModuleFactory, ModuleInstance, ModuleRef } from "./config/define.ts";
export { tmpl } from "./config/context.ts";
export type {
  AptRepoOptions,
  Ctx,
  ExecOptions,
  FileOptions,
  FlatpakOptions,
  GitOptions,
  KconfigValue,
  LinkTreeOptions,
  PkgName,
  RepoOptions,
} from "./config/context.ts";
export type { Secret } from "./secrets/secret.ts";

// Plugin API (stable, see docs/plugins.md): custom resource types.
export { defineType, PLUGIN_API_VERSION, type TypeDefinition } from "./plugin.ts";
export { pick } from "./types.ts";
export type {
  ApplyContext,
  Change,
  ChangeAction,
  DestroyPlan,
  DiffContext,
  DiffResult,
  Executor,
  Executors,
  Extraneous,
  ExtraneousOptions,
  Facts,
  ResourceBase,
  ResourceType,
  Result,
  RunOptions,
  RunResult,
  Scope,
  Stat,
  StatType,
  ValidateContext,
} from "./types.ts";
