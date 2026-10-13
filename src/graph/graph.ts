import { dirname } from "node:path";
import type { Provenance, ResourceType, Scope } from "../types.ts";

export interface Decl {
  id: string;
  type: ResourceType;
  spec: any;
  scope: Scope;
  provenance: Provenance[];
  /** Declaration index, used as a stable tiebreaker. */
  seq: number;
  deps: string[];
}

const PATH_KINDS = new Set(["file", "link", "dir", "git"]);
/** Kinds that edit part of a file rig doesn't otherwise own. */
const PARTIAL_KINDS = new Set(["line", "kcfg"]);

export const fmtProv = (p: Provenance) => `${p.modules.join(" > ") || "<host>"} (${p.site})`;

export class Graph {
  readonly decls = new Map<string, Decl>();
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  /** Absolute repo paths evaluation read (link targets, file sources, keys): what a remote bundle must carry. */
  readonly assets = new Set<string>();
  /** Names of secrets the config asked for. */
  readonly secrets = new Set<string>();
  /** Package names (globs) modules asked to remove with pkg.remove, merged with the host's packages.remove. */
  readonly removals: string[] = [];
  /** Modules asked to prune orphaned dependencies with pkg.removeOrphans. */
  removeOrphans = false;
  private seq = 0;

  add(type: ResourceType, spec: any, prov: Provenance): string {
    const id = type.id(spec);
    const existing = this.decls.get(id);
    if (existing) {
      const merged = type.merge ? type.merge(existing.spec, spec) : type.equal(existing.spec, spec) ? existing.spec : "conflicting declarations";
      if (typeof merged === "string") {
        this.errors.push(`${merged} of ${id}:\n    ${fmtProv(existing.provenance[0]!)}\n    ${fmtProv(prov)}`);
        return id;
      }
      existing.provenance.push(prov);
      const after = [...new Set([...(existing.spec.after ?? []), ...(spec.after ?? [])])];
      existing.spec = after.length ? { ...merged, after } : merged;
      return id;
    }
    this.decls.set(id, { id, type, spec, scope: type.scope(spec), provenance: [prov], seq: this.seq++, deps: [] });
    return id;
  }

  /** Resolve edges and check structural problems. Returns IDs in topological order. */
  finalize(): string[] {
    const pathOwner = new Map<string, string>();
    const dirs = new Set<string>();
    const links = new Set<string>();
    for (const d of this.decls.values()) {
      if (!PATH_KINDS.has(d.type.kind)) continue;
      const p = d.spec.path as string;
      const other = pathOwner.get(p);
      if (other) this.errors.push(`${p} is declared as both ${other} and ${d.id}`);
      pathOwner.set(p, d.id);
      if (d.type.kind === "dir") dirs.add(p);
      if (d.type.kind === "link") links.add(p);
    }
    for (const d of this.decls.values()) {
      if (!PARTIAL_KINDS.has(d.type.kind)) continue;
      const owner = pathOwner.get(d.spec.path);
      if (owner) this.errors.push(`${d.id} edits ${d.spec.path}, which is fully managed as ${owner}`);
    }

    // Packages per module, for types that implicitly come after "their" packages.
    const pkgsByModule = new Map<string, string[]>();
    for (const d of this.decls.values()) {
      if (!d.type.kind.startsWith("pkg:")) continue;
      for (const p of d.provenance) {
        const m = p.modules.at(-1) ?? "";
        (pkgsByModule.get(m) ?? pkgsByModule.set(m, []).get(m)!).push(d.id);
      }
    }

    for (const d of this.decls.values()) {
      const deps = new Set<string>(d.spec.after ?? []);
      for (const e of d.type.edges?.(d.spec) ?? []) deps.add(e);
      if (d.type.afterPackages) for (const p of d.provenance) for (const id of pkgsByModule.get(p.modules.at(-1) ?? "") ?? []) deps.add(id);
      if (PATH_KINDS.has(d.type.kind)) {
        // Implicit edge to the nearest declared ancestor dir; and refuse to manage paths inside a symlinked dir.
        let p = dirname(d.spec.path);
        let foundDir = false;
        while (true) {
          if (links.has(p))
            this.errors.push(`${d.id} is inside the linked directory ${p} — it would write into the repo (${fmtProv(d.provenance[0]!)})`);
          if (!foundDir && dirs.has(p)) {
            deps.add(`dir:${p}`);
            foundDir = true;
          }
          const up = dirname(p);
          if (up === p) break;
          p = up;
        }
      }
      for (const dep of deps) {
        if (!this.decls.has(dep)) this.errors.push(`${d.id} depends on unknown resource ${dep} (${fmtProv(d.provenance[0]!)})`);
      }
      d.deps = [...deps].filter((x) => this.decls.has(x));
    }
    return this.toposort();
  }

  private toposort(): string[] {
    const indeg = new Map<string, number>();
    const rev = new Map<string, string[]>();
    for (const d of this.decls.values()) {
      indeg.set(d.id, d.deps.length);
      for (const dep of d.deps) (rev.get(dep) ?? rev.set(dep, []).get(dep)!).push(d.id);
    }
    const bySeq = (a: string, b: string) => this.decls.get(a)!.seq - this.decls.get(b)!.seq;
    let ready = [...indeg].filter(([, n]) => n === 0).map(([id]) => id).sort(bySeq);
    const order: string[] = [];
    while (ready.length) {
      const next: string[] = [];
      for (const id of ready) {
        order.push(id);
        for (const child of rev.get(id) ?? []) {
          const n = indeg.get(child)! - 1;
          indeg.set(child, n);
          if (n === 0) next.push(child);
        }
      }
      ready = next.sort(bySeq);
    }
    if (order.length < this.decls.size) {
      const stuck = [...indeg].filter(([, n]) => n > 0).map(([id]) => id);
      this.errors.push(`dependency cycle among: ${stuck.join(", ")}`);
    }
    return order;
  }
}
