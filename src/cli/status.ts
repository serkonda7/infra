// `rig status`: the current generation, drift between the machine and the
// config, package-manager config files waiting to be merged, failed units.

import { closeExecutors, gitCommit, plan as makePlan, prepare, type EngineOptions } from "../engine.ts";
import { planView, type ItemView } from "../plan/format.ts";
import { PENDING_SUFFIXES } from "../plan/plan.ts";
import type { Generation } from "../state/state.ts";
import type { Executors } from "../types.ts";
import { lines } from "../resources/util.ts";
import { c } from "./ui.ts";

export interface StatusView {
  host: string;
  os: string;
  generation: Omit<Generation, "resources" | "host"> & { resources: number } | null;
  /** The repo's commit now (with -dirty for uncommitted changes). */
  commit: string | null;
  drift: { add: number; change: number; destroy: number; blocked: number; items: Pick<ItemView, "id" | "op" | "display" | "note" | "reason">[] };
  /** .pacnew / .dpkg-dist files; `managed` when rig writes or edits the file they belong to. */
  pending: { path: string; managed: boolean }[];
  failedUnits: { name: string; user: boolean }[];
}

/** Every pending package config under `etc` (pacdiff's job, but worth seeing here). */
async function pendingConfigs(x: Executors, etc: string): Promise<string[]> {
  const names = PENDING_SUFFIXES.flatMap((s, i) => [...(i ? ["-o"] : []), "-name", `*${s}`]);
  // Unreadable directories make find exit non-zero; what it did find is still printed.
  const r = await x.user.run(["find", etc, "-xdev", "(", ...names, ")", "-print"]);
  return lines(r.stdout).sort();
}

async function failedUnits(x: Executors): Promise<StatusView["failedUnits"]> {
  const out: StatusView["failedUnits"] = [];
  for (const user of [false, true]) {
    const r = await x.user.run(["systemctl", ...(user ? ["--user"] : []), "--failed", "--plain", "--no-legend", "--no-pager"], { env: { LC_ALL: "C" } });
    if (r.code !== 0) continue;
    for (const l of lines(r.stdout)) {
      const name = l.replace(/^●\s*/, "").split(/\s+/)[0];
      if (name) out.push({ name, user });
    }
  }
  return out;
}

export async function status(engine: EngineOptions, opts: { etc?: string } = {}): Promise<StatusView> {
  const p = await prepare({ ...engine, fast: true });
  try {
    const plan = await makePlan(p, engine);
    const view = planView(plan);
    const managed = new Set([...p.graph.decls.values()].filter((d) => d.type.kind === "file" || d.type.kind === "line").map((d) => d.spec.path as string));
    const [commit, pending, failed] = await Promise.all([gitCommit(p.repo), pendingConfigs(p.x, opts.etc ?? "/etc"), failedUnits(p.x)]);
    const g = plan.prev;
    return {
      host: p.hostName,
      os: p.facts.os.name,
      generation: g ? { id: g.id, at: g.at, commit: g.commit, status: g.status, ...(g.snapshot ? { snapshot: g.snapshot } : {}), ...(g.rollbackOf ? { rollbackOf: g.rollbackOf } : {}), resources: Object.keys(g.resources).length } : null,
      commit,
      drift: {
        ...view.summary,
        items: view.items.filter((i) => i.op !== "noop" && i.op !== "forget").map(({ id, op, display, note, reason }) => ({ id, op, display, note, reason })),
      },
      pending: pending.map((path) => ({ path, managed: managed.has(PENDING_SUFFIXES.reduce((p, s) => (p.endsWith(s) ? p.slice(0, -s.length) : p), path)) })),
      failedUnits: failed,
    };
  } finally {
    await closeExecutors(p.x);
  }
}

const SIGIL: Record<string, string> = { create: c.green("+"), update: c.yellow("~"), run: c.yellow("▶"), destroy: c.red("-"), blocked: c.red("!") };

export function formatStatus(s: StatusView): string {
  const out: string[] = [];
  const row = (label: string, text: string) => out.push(`${c.bold(label.padEnd(13))}${text}`);
  const g = s.generation;
  out.push(`${c.bold("host")} ${s.host} · ${s.os}`);

  if (!g) row("generation", c.dim("none yet — nothing applied on this machine"));
  else {
    const parts = [g.at.replace("T", " ").slice(0, 16), g.commit ?? "no commit", g.status === "ok" ? c.green("ok") : c.yellow(g.status)];
    if (g.snapshot) parts.push(`snapshot ${g.snapshot}`);
    if (g.rollbackOf) parts.push(`rollback of ${g.rollbackOf}`);
    row("generation", `${g.id} · ${parts.join(" · ")}`);
    if (s.commit && g.commit !== s.commit) row("config", c.yellow(`${s.commit} — changed since generation ${g.id}`));
  }

  const d = s.drift;
  if (!d.items.length) row("drift", c.green("none — the machine matches the configuration"));
  else {
    const counts = [d.add && `${d.add} to add`, d.change && `${d.change} to change`, d.destroy && `${d.destroy} to remove`, d.blocked && c.red(`${d.blocked} blocked`)].filter(Boolean);
    row("drift", `${counts.join(", ")} ${c.dim("(rig plan for details)")}`);
    for (const i of d.items.slice(0, 12)) out.push(`${" ".repeat(13)}${SIGIL[i.op] ?? " "} ${i.display}${i.reason ? c.dim(`  (${i.reason})`) : ""}`);
    if (d.items.length > 12) out.push(c.dim(`${" ".repeat(13)}… and ${d.items.length - 12} more`));
  }

  if (!s.pending.length) row("pending", c.dim("no .pacnew / .dpkg-dist files"));
  else s.pending.forEach((p, i) => row(i ? "" : "pending", `${c.yellow(p.path)}${p.managed ? c.dim("  (rig manages this file)") : ""}`));

  if (!s.failedUnits.length) row("failed units", c.green("none"));
  else s.failedUnits.forEach((u, i) => row(i ? "" : "failed units", c.red(u.user ? `${u.name} (user)` : u.name)));
  return out.join("\n");
}
