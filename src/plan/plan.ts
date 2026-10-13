import type { ChangeAction, Change, Executors, Facts, ResourceType, Scope } from "../types.ts";
import { pick } from "../types.ts";
import type { Decl, Graph } from "../graph/graph.ts";
import type { GenEntry, Generation } from "../state/state.ts";
import type { TypeRegistry } from "../resources/index.ts";

interface ItemBase {
  id: string;
  type: ResourceType;
  scope: Scope;
  display: string;
}

export type PlanItem =
  | (ItemBase & { op: "change"; action: ChangeAction; note?: string; detail?: string; change: Change; deps: string[] })
  | (ItemBase & { op: "noop"; meta: unknown })
  | (ItemBase & { op: "blocked"; reason: string; prev?: GenEntry; destroying: boolean })
  | (ItemBase & { op: "destroy" | "forget"; meta: unknown; note?: string; prev: GenEntry });

export interface Plan {
  host: string;
  facts: Facts;
  prev: Generation | null;
  /** Desired resources in topological order, then destroys. */
  items: PlanItem[];
  /** Previous-generation entries outside this run's filter; kept verbatim. */
  carried: Record<string, GenEntry>;
  warnings: string[];
}

export interface PlanInput {
  host: string;
  facts: Facts;
  graph: Graph;
  order: string[];
  prev: Generation | null;
  types: TypeRegistry;
  x: Executors;
  repo: string;
  force?: boolean;
  /** Restrict this run (rig dot, --only). Resources outside are neither applied nor pruned. */
  filter?: (r: { id: string; scope: Scope; decl?: Decl }) => boolean;
  /** Exact package mode: undeclared explicit packages are pruned too. */
  exact?: { keep: string[]; demote: boolean };
}

export async function makePlan(input: PlanInput): Promise<Plan> {
  const { graph, prev, types, x, facts } = input;
  const home = facts.user.home;
  const filter = input.filter ?? (() => true);
  const force = input.force ?? false;

  const desired = input.order.map((id) => graph.decls.get(id)!).filter((d) => filter({ id: d.id, scope: d.scope, decl: d }));
  const carried: Record<string, GenEntry> = {};
  const destroys: [string, GenEntry][] = [];
  for (const [id, entry] of Object.entries(prev?.resources ?? {})) {
    const decl = graph.decls.get(id);
    const inFilter = filter({ id, scope: entry.scope, decl });
    if (!inFilter) carried[id] = entry;
    else if (!decl) destroys.push([id, entry]);
  }

  const warnings = [...graph.warnings];
  if (input.exact) {
    const declared = new Set(graph.decls.keys());
    let extra = 0;
    for (const type of types.all) {
      if (!type.extraneous) continue;
      for (const e of await type.extraneous({ declared, ...input.exact }, x)) {
        if (prev?.resources[e.id] || !filter({ id: e.id, scope: e.scope })) continue;
        destroys.push([e.id, { kind: type.kind, scope: e.scope, meta: e.meta, display: e.display }]);
        extra++;
      }
    }
    if (extra) warnings.push(`exact package mode: ${extra} undeclared package${extra > 1 ? "s" : ""} will be ${input.exact.demote ? "marked as dependencies" : "removed"}`);
  }

  // Batched reads, one call per resource type.
  const byKind = new Map<string, { id: string; scope: Scope; spec?: unknown; meta?: unknown }[]>();
  const push = (kind: string, item: { id: string; scope: Scope; spec?: unknown; meta?: unknown }) =>
    (byKind.get(kind) ?? byKind.set(kind, []).get(kind)!).push(item);
  for (const d of desired) push(d.type.kind, { id: d.id, scope: d.scope, spec: d.spec });
  for (const [id, e] of destroys) push(e.kind, { id, scope: e.scope, meta: e.meta });
  const live = new Map<string, unknown>();
  await Promise.all(
    [...byKind].map(async ([kind, items]) => {
      for (const [id, v] of await types.get(kind).read(items as any, x)) live.set(id, v);
    }),
  );

  warnings.push(...(await pendingPackageConfigs(desired, x)).map((p) => `${p} is pending: the package shipped a new version of a file rig manages — merge what you need, then delete it`));

  const items: PlanItem[] = [];
  const changed = new Set<string>();
  const dctx = { force, changed, home, repo: input.repo };
  for (const d of desired) {
    const prevMeta = prev?.resources[d.id]?.meta;
    const l = live.get(d.id) ?? null;
    const base = { id: d.id, type: d.type, scope: d.scope, display: d.type.display(d.id, d.spec, { home, repo: input.repo }) };
    const r = d.type.diff(d.spec, l, prevMeta, dctx);
    if (r.op === "noop") items.push({ ...base, op: "noop", meta: r.meta });
    else if (r.op === "blocked") items.push({ ...base, op: "blocked", reason: r.reason, prev: prev?.resources[d.id], destroying: false });
    else {
      changed.add(d.id);
      const change: Change = { id: d.id, action: r.action, spec: d.spec, live: l, prevMeta, note: r.note, detail: r.detail };
      items.push({ ...base, op: "change", action: r.action, note: r.note, detail: r.detail, change, deps: d.deps });
    }
  }

  for (const [id, entry] of destroys) {
    const type = types.get(entry.kind);
    const base = { id, type, scope: entry.scope, display: entry.display };
    const l = live.get(id) ?? null;
    const r = type.planDestroy ? type.planDestroy(id, entry.meta, l, dctx) : { op: "forget" as const };
    if (r.op === "blocked") items.push({ ...base, op: "blocked", reason: r.reason, prev: entry, destroying: true });
    else items.push({ ...base, op: r.op, meta: entry.meta, note: r.note, prev: entry });
  }

  return { host: input.host, facts, prev, items, carried, warnings };
}

/** Package managers leave new config versions next to files that were changed locally. */
export const PENDING_SUFFIXES = [".pacnew", ".dpkg-dist", ".ucf-dist"];

/** .pacnew / .dpkg-dist siblings of system files that rig writes or edits. */
export async function pendingPackageConfigs(decls: Decl[], x: Executors): Promise<string[]> {
  const paths = new Set(decls.filter((d) => d.scope === "system" && (d.type.kind === "file" || d.type.kind === "line")).map((d) => d.spec.path as string));
  const found = await Promise.all(
    [...paths].flatMap((p) => PENDING_SUFFIXES.map(async (suffix) => ((await pick(x, "system").lstat(p + suffix).catch(() => null)) ? p + suffix : null))),
  );
  return found.filter((p): p is string => !!p);
}

export function summarize(plan: Plan) {
  let add = 0, change = 0, destroy = 0, blocked = 0, forget = 0;
  for (const i of plan.items) {
    if (i.op === "change") i.action === "create" ? add++ : change++;
    else if (i.op === "destroy") destroy++;
    else if (i.op === "blocked") blocked++;
    else if (i.op === "forget") forget++;
  }
  return { add, change, destroy, blocked, forget, actionable: add + change + destroy > 0 };
}
