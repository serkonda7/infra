import type { Plan } from "./plan.ts";
import { summarize } from "./plan.ts";
import type { ApplyEvent } from "../apply/apply.ts";
import { c } from "../cli/ui.ts";

/**
 * A plan reduced to plain data: what the terminal renderer and --json need,
 * and what a remote run streams back to the local CLI.
 */
export interface PlanView {
  host: string;
  os: string;
  cpuLevel: string;
  generation: number | null;
  warnings: string[];
  summary: ReturnType<typeof summarize>;
  /** Some change or destroy needs root. */
  needsRoot: boolean;
  items: ItemView[];
}

export interface ItemView {
  id: string;
  kind: string;
  /** Section heading and its sort order. */
  label: string;
  order: number;
  scope: "user" | "system";
  display: string;
  op: "create" | "update" | "run" | "noop" | "destroy" | "forget" | "blocked";
  note?: string;
  detail?: string;
  reason?: string;
}

export function planView(plan: Plan): PlanView {
  return {
    host: plan.host,
    os: plan.facts.os.name,
    cpuLevel: plan.facts.cpu.level,
    generation: plan.prev?.id ?? null,
    warnings: plan.warnings,
    summary: summarize(plan),
    needsRoot: plan.items.some((i) => (i.op === "change" || i.op === "destroy") && i.scope === "system"),
    items: plan.items.map((i) => ({
      id: i.id,
      kind: i.type.kind,
      label: i.type.label,
      order: i.type.order,
      scope: i.scope,
      display: i.display,
      op: i.op === "change" ? i.action : i.op,
      ...("note" in i && i.note ? { note: i.note } : {}),
      ...(i.op === "change" && i.detail ? { detail: i.detail } : {}),
      ...(i.op === "blocked" ? { reason: i.reason } : {}),
    })),
  };
}

const SIGIL: Record<ItemView["op"], string> = {
  create: c.green("+"),
  update: c.yellow("~"),
  run: c.yellow("▶"),
  noop: c.dim("="),
  destroy: c.red("-"),
  forget: c.dim("·"),
  blocked: c.red("!"),
};

const colorDiff = (detail: string) =>
  detail
    .split("\n")
    .map((l) => "      " + (l.startsWith("@@") ? c.cyan(l) : l.startsWith("+") ? c.green(l) : l.startsWith("-") ? c.red(l) : c.dim(l)))
    .join("\n");

export function formatPlan(plan: Plan | PlanView, opts: { verbose?: boolean } = {}): string {
  const v = "facts" in plan ? planView(plan) : plan;
  const lines: string[] = [];
  const cur = v.generation !== null ? `generation ${v.generation}` : "no generations yet";
  lines.push(`${c.bold("host")} ${v.host} · ${v.os} (${v.cpuLevel}) · ${cur}`);

  const shown = v.items.filter((i) => opts.verbose || i.op !== "noop");
  const sections = new Map<string, ItemView[]>();
  for (const i of shown) (sections.get(i.label) ?? sections.set(i.label, []).get(i.label)!).push(i);
  const order = [...sections.keys()].sort((a, b) => sections.get(a)![0]!.order - sections.get(b)![0]!.order);

  for (const label of order) {
    const group = sections.get(label)!;
    lines.push("", c.bold(label));
    if (group[0]!.kind.startsWith("pkg:")) {
      // Packages are compact: one line per operation.
      const byOp = new Map<string, ItemView[]>();
      for (const i of group) (byOp.get(i.op) ?? byOp.set(i.op, []).get(i.op)!).push(i);
      for (const [, list] of byOp) {
        const simple = list.filter((i) => !i.note && i.op !== "blocked");
        if (simple.length) lines.push(`  ${SIGIL[simple[0]!.op]} ${simple.map((i) => i.display).join(" ")}`);
        for (const i of list.filter((i) => !simple.includes(i))) lines.push(itemLine(i));
      }
      continue;
    }
    for (const i of group) {
      lines.push(itemLine(i));
      if (i.detail) lines.push(colorDiff(i.detail));
    }
  }

  if (v.warnings.length) {
    lines.push("", c.yellow("warnings"));
    for (const w of v.warnings) lines.push(`  ${c.yellow("⚠")} ${w}`);
  }

  const s = v.summary;
  lines.push("");
  if (!s.actionable && !s.blocked) lines.push(c.green("No changes. The machine matches the configuration."));
  else {
    const parts = [`${s.add} to add`, `${s.change} to change`, `${s.destroy} to destroy`];
    if (s.blocked) parts.push(c.red(`${s.blocked} blocked`));
    lines.push(parts.join(", ") + ".");
  }
  return lines.join("\n");
}

function itemLine(i: ItemView): string {
  const note = i.op === "blocked" ? c.red(i.reason ?? "") : i.note ? c.dim(i.note) : "";
  const name = i.op === "forget" ? c.dim(i.display) : i.display;
  return `  ${SIGIL[i.op]} ${name}${note ? `  ${c.dim("(")}${note}${c.dim(")")}` : ""}`;
}

/** JSON-friendly plan (no file contents, no type objects). */
export function planJson(plan: Plan | PlanView) {
  const v = "facts" in plan ? planView(plan) : plan;
  return {
    host: v.host,
    generation: v.generation,
    summary: v.summary,
    warnings: v.warnings,
    items: v.items
      .filter((i) => i.op !== "noop")
      .map((i) => ({
        id: i.id,
        op: i.op,
        scope: i.scope,
        display: i.display,
        ...(i.reason !== undefined ? { reason: i.reason } : {}),
        ...(i.note ? { note: i.note } : {}),
        ...(i.detail ? { diff: i.detail } : {}),
      })),
  };
}

// ---------------------------------------------------------------------------
// Apply events

export interface EventView {
  id: string;
  display: string;
  op: ItemView["op"];
  ok: boolean;
  skipped?: boolean;
  error?: string;
  note?: string;
}

export function eventView(e: ApplyEvent): EventView {
  const i = e.item;
  return {
    id: i.id,
    display: i.display,
    op: i.op === "change" ? i.action : i.op,
    ok: e.ok,
    ...(e.skipped ? { skipped: true } : {}),
    ...(e.error ? { error: e.error } : {}),
    ...(e.note ? { note: e.note } : {}),
  };
}

export function formatEvent(e: EventView): string {
  const sig = e.op === "create" ? "+" : e.op === "update" ? "~" : e.op === "run" ? "▶" : "-";
  const mark = e.ok ? c.green("✓") : e.skipped ? c.yellow("↷") : c.red("✗");
  const note = e.ok ? (e.note ? c.dim(`  (${e.note})`) : "") : `\n      ${c.red(e.error ?? "failed")}`;
  return `  ${mark} ${sig} ${e.display}${note}`;
}

export const eventJson = (e: EventView) => ({ id: e.id, ok: e.ok, ...(e.error ? { error: e.error } : {}), ...(e.note ? { note: e.note } : {}) });
