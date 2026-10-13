import type { ApplyContext, Executors, ObjectStore, Result } from "../types.ts";
import type { Plan, PlanItem } from "../plan/plan.ts";
import type { GenEntry, Generation } from "../state/state.ts";
import { errMsg } from "../resources/util.ts";

export interface ApplyEvent {
  item: PlanItem;
  ok: boolean;
  error?: string;
  note?: string;
  skipped?: boolean;
}

export interface ApplyOptions {
  x: Executors;
  objects: ObjectStore;
  repo: string;
  commit: string | null;
  force?: boolean;
  verbose?: boolean;
  onEvent?: (e: ApplyEvent) => void;
  /**
   * Changes that could cut the connection (sshd, firewall, network) are applied last,
   * after `arm` has set up a way to revert them. Everything depending on them waits too.
   */
  guard?: {
    risky(item: ChangeItem): boolean;
    arm(items: ChangeItem[]): Promise<void>;
  };
}

export interface ApplyOutcome {
  generation: Generation;
  /** False when the resource set is unchanged, so no new generation was written. */
  dirty: boolean;
  failed: number;
  events: ApplyEvent[];
  /** IDs applied under the guard (see ApplyOptions.guard). */
  guarded: string[];
}

export type ChangeItem = Extract<PlanItem, { op: "change" }>;
type DestroyItem = Extract<PlanItem, { op: "destroy" | "forget" }>;

export async function applyPlan(plan: Plan, opts: ApplyOptions): Promise<ApplyOutcome> {
  const changed = new Set<string>();
  const ctx: ApplyContext = {
    force: opts.force ?? false,
    verbose: opts.verbose ?? false,
    objects: opts.objects,
    home: plan.facts.user.home,
    repo: opts.repo,
    user: plan.facts.user.name,
    changed,
  };
  const events: ApplyEvent[] = [];
  const emit = (e: ApplyEvent) => {
    events.push(e);
    opts.onEvent?.(e);
  };
  const resources: Record<string, GenEntry> = { ...plan.carried };
  const entry = (i: PlanItem, meta: unknown): GenEntry => ({ kind: i.type.kind, scope: i.scope, meta, display: i.display });

  // 1. Destroys first (paths may be reused by a new resource), dependents-before-dependencies by kind.
  const destroys = plan.items.filter((i): i is DestroyItem => i.op === "destroy");
  const destroyKinds = [...new Set(destroys.map((d) => d.type))].sort((a, b) => b.order - a.order);
  for (const type of destroyKinds) {
    const batch = destroys.filter((d) => d.type === type);
    let results: Result<null>[];
    try {
      results = await type.destroy!(batch.map((d) => ({ id: d.id, scope: d.scope, meta: d.meta })), opts.x, ctx);
    } catch (e) {
      results = batch.map((d) => ({ id: d.id, ok: false as const, error: errMsg(e) }));
    }
    for (const d of batch) {
      const r = results.find((r) => r.id === d.id) ?? { id: d.id, ok: false as const, error: "no result" };
      if (!r.ok) resources[d.id] = d.prev; // still owned; retried next run
      emit({ item: d, ok: r.ok, error: r.ok ? undefined : r.error, note: r.ok ? r.note : undefined });
    }
  }

  // Blocked destroys stay owned; forgets just drop out.
  for (const i of plan.items) if (i.op === "blocked" && i.destroying && i.prev) resources[i.id] = i.prev;

  // 2. Desired resources: noops keep their meta; blocked ones keep whatever we owned before.
  for (const i of plan.items) {
    if (i.op === "noop") resources[i.id] = entry(i, i.meta);
    if (i.op === "blocked" && !i.destroying && i.prev) resources[i.id] = i.prev;
  }

  // 3. Changes by topological level; within a level by kind order, batched per kind.
  //    Deferred kinds (triggers) run afterwards, see 4. With a guard, risky changes go last.
  const allChanges = plan.items.filter((i): i is ChangeItem => i.op === "change");
  const changes = allChanges.filter((c) => !c.type.deferred);
  const planned = new Set(changes.map((c) => c.id));
  const blocked = new Set(plan.items.filter((i) => i.op === "blocked").map((i) => i.id));
  const level = new Map<string, number>();
  for (const c of changes) level.set(c.id, 1 + Math.max(-1, ...c.deps.filter((d) => planned.has(d)).map((d) => level.get(d) ?? 0)));
  const failed = new Set<string>(blocked);

  // Guarded tail: risky changes plus everything after them (changes are in topological order).
  const tail = new Set<string>();
  if (opts.guard) for (const c of changes) if (opts.guard.risky(c) || c.deps.some((d) => tail.has(d))) tail.add(c.id);

  await runLevels(changes.filter((c) => !tail.has(c.id)));
  if (tail.size) {
    const guarded = changes.filter((c) => tail.has(c.id));
    let armError: string | null = null;
    try {
      await opts.guard!.arm(guarded);
    } catch (e) {
      armError = errMsg(e);
    }
    if (!armError) await runLevels(guarded);
    else {
      for (const c of guarded) {
        failed.add(c.id);
        const prevEntry = plan.prev?.resources[c.id];
        if (prevEntry) resources[c.id] = prevEntry;
        emit({ item: c, ok: false, error: `not applied: dead-man's switch could not be armed: ${armError}` });
      }
    }
  }

  async function runLevels(list: ChangeItem[]) {
    for (const lv of [...new Set(list.map((c) => level.get(c.id)!))].sort((a, b) => a - b)) {
      const atLevel = list.filter((c) => level.get(c.id) === lv);
      const kinds = [...new Set(atLevel.map((c) => c.type))].sort((a, b) => a.order - b.order);
      for (const type of kinds) {
        const batch: ChangeItem[] = [];
        for (const c of atLevel.filter((c) => c.type === type)) {
          const bad = c.deps.find((d) => failed.has(d));
          if (bad) {
            failed.add(c.id);
            const prevEntry = plan.prev?.resources[c.id];
            if (prevEntry) resources[c.id] = prevEntry;
            emit({ item: c, ok: false, skipped: true, error: `skipped: ${bad} did not apply` });
          } else batch.push(c);
        }
        if (!batch.length) continue;
        let results: Result[];
        try {
          results = await type.apply(batch.map((c) => c.change), opts.x, ctx);
        } catch (e) {
          results = batch.map((c) => ({ id: c.id, ok: false as const, error: errMsg(e) }));
        }
        for (const c of batch) {
          const r = results.find((r) => r.id === c.id) ?? { id: c.id, ok: false as const, error: "no result" };
          if (r.ok) {
            resources[c.id] = entry(c, r.meta);
            if (!r.note?.startsWith("skipped")) changed.add(c.id);
          } else {
            failed.add(c.id);
            const prevEntry = plan.prev?.resources[c.id];
            if (prevEntry) resources[c.id] = prevEntry;
          }
          emit({ item: c, ok: r.ok, error: r.ok ? undefined : r.error, note: r.ok ? r.note : undefined });
        }
      }
    }
  }

  // 4. Triggers: once each, in declaration order. They fire if anything they watch changed,
  //    even when other watched resources failed.
  const deferred = allChanges.filter((c) => c.type.deferred);
  for (const type of [...new Set(deferred.map((c) => c.type))]) {
    const batch = deferred.filter((c) => c.type === type);
    let results: Result[];
    try {
      results = await type.apply(batch.map((c) => c.change), opts.x, ctx);
    } catch (e) {
      results = batch.map((c) => ({ id: c.id, ok: false as const, error: errMsg(e) }));
    }
    for (const c of batch) {
      const r = results.find((r) => r.id === c.id) ?? { id: c.id, ok: false as const, error: "no result" };
      if (r.ok) resources[c.id] = entry(c, r.meta);
      else if (plan.prev?.resources[c.id]) resources[c.id] = plan.prev.resources[c.id]!;
      emit({ item: c, ok: r.ok, error: r.ok ? undefined : r.error, note: r.ok ? r.note : undefined, skipped: r.ok && r.note?.startsWith("skipped") });
    }
  }

  const failures = events.filter((e) => !e.ok).length;
  const prevResources = plan.prev?.resources ?? {};
  const dirty = !plan.prev || JSON.stringify(sortKeys(prevResources)) !== JSON.stringify(sortKeys(resources));
  const generation: Generation = {
    id: dirty ? (plan.prev?.id ?? 0) + 1 : plan.prev!.id,
    at: new Date().toISOString(),
    host: plan.host,
    commit: opts.commit,
    status: failures || blocked.size ? "partial" : "ok",
    resources: sortKeys(resources),
  };
  return { generation, dirty, failed: failures, events, guarded: [...tail] };
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
