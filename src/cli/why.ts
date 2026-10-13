// `rig why <id|path|name>`: which module declared a resource, and how it
// hangs together with the rest of the graph.

import type { Graph } from "../graph/graph.ts";
import type { Generation } from "../state/state.ts";
import type { Provenance, Scope } from "../types.ts";
import { idPath, targetPath } from "../resources/util.ts";
import { c } from "./ui.ts";

export interface WhyNode {
  id: string;
  label: string;
  scope: Scope;
  display: string;
  declaredBy: Provenance[];
  /** Direct dependencies (explicit after, implicit edges). */
  deps: string[];
  /** Resources that directly depend on this one. */
  dependents: string[];
}

export interface WhyResult {
  query: string;
  host: string;
  matches: WhyNode[];
  /** Not declared any more, but still owned by the latest generation: the next apply removes them. */
  owned: { id: string; display: string; generation: number }[];
}

const isGlob = (q: string) => /[*?[{]/.test(q);

/** Exact ID; else everything at a path; else IDs ending in ":<query>" (package names, units); else a glob or substring. */
export function resolveIds(ids: string[], query: string, home: string, pathOf: (id: string) => string | undefined): string[] {
  if (ids.includes(query)) return [query];
  if (query.startsWith("/") || query.startsWith("~")) {
    let path: string | null = null;
    try {
      path = targetPath(query.replace(/\/+$/, "") || "/", home);
    } catch {}
    const hits = path ? ids.filter((id) => pathOf(id) === path) : [];
    if (hits.length) return hits;
  }
  const named = ids.filter((id) => id.endsWith(":" + query));
  if (named.length) return named;
  if (isGlob(query)) {
    const g = new Bun.Glob(query);
    return ids.filter((id) => g.match(id));
  }
  return ids.filter((id) => id.includes(query));
}

export function why(graph: Graph, prev: Generation | null, query: string, ctx: { host: string; home: string; repo: string }): WhyResult {
  const dependents = new Map<string, string[]>();
  for (const d of graph.decls.values()) for (const dep of d.deps) (dependents.get(dep) ?? dependents.set(dep, []).get(dep)!).push(d.id);

  const ids = resolveIds([...graph.decls.keys()], query, ctx.home, (id) => graph.decls.get(id)?.spec?.path);
  const matches = ids.map((id): WhyNode => {
    const d = graph.decls.get(id)!;
    return {
      id,
      label: d.type.label,
      scope: d.scope,
      display: d.type.display(id, d.spec, ctx),
      declaredBy: d.provenance,
      deps: d.deps,
      dependents: dependents.get(id) ?? [],
    };
  });

  const undeclared = Object.keys(prev?.resources ?? {}).filter((id) => !graph.decls.has(id));
  const owned = matches.length
    ? []
    : resolveIds(undeclared, query, ctx.home, (id) => (/^(file|link|dir|git):/.test(id) ? idPath(id) : undefined)).map((id) => ({
        id,
        display: prev!.resources[id]!.display,
        generation: prev!.id,
      }));
  return { query, host: ctx.host, matches, owned };
}

const prov = (p: Provenance) => `${c.bold(p.modules.join(" › ") || "host")}  ${c.dim(p.site)}`;

export function formatWhy(r: WhyResult, graph: Graph): string {
  const lines: string[] = [];
  if (!r.matches.length) {
    if (r.owned.length) {
      for (const o of r.owned)
        lines.push(`${c.bold(o.id)}\n  ${c.yellow("no longer declared")} — still owned by generation ${o.generation}; the next \`rig apply\` removes it`);
      return lines.join("\n");
    }
    return `nothing on ${r.host} declares ${JSON.stringify(r.query)}`;
  }
  const first = (id: string) => graph.decls.get(id)?.provenance[0];
  const ref = (id: string) => {
    const p = first(id);
    return `${id}${p ? `  ${c.dim(`${p.modules.join(" › ") || "host"} ${p.site}`)}` : ""}`;
  };

  for (const [n, m] of r.matches.entries()) {
    if (n) lines.push("");
    lines.push(`${c.bold(m.id)}  ${c.dim(`${m.label} · ${m.scope}`)}`);
    if (m.display !== m.id) lines.push(`  ${m.display}`);
    lines.push(c.dim("  declared by"));
    for (const p of m.declaredBy) lines.push(`    ${prov(p)}`);

    lines.push(c.dim("  depends on"));
    if (!m.deps.length) lines.push(c.dim("    nothing"));
    // The whole chain, so "why is this applied after that" has an answer.
    const seen = new Set<string>([m.id]);
    const tree = (id: string, depth: number) => {
      for (const dep of graph.decls.get(id)?.deps ?? []) {
        lines.push(`${"  ".repeat(depth + 2)}${seen.has(dep) ? c.dim(`${dep} (see above)`) : ref(dep)}`);
        if (seen.has(dep)) continue;
        seen.add(dep);
        if (depth < 8) tree(dep, depth + 1);
      }
    };
    tree(m.id, 0);

    lines.push(c.dim("  needed by"));
    if (!m.dependents.length) lines.push(c.dim("    nothing"));
    for (const d of m.dependents) lines.push(`    ${ref(d)}`);
  }
  if (r.matches.length > 1) lines.push("", c.dim(`${r.matches.length} resources match ${JSON.stringify(r.query)}`));
  return lines.join("\n");
}
