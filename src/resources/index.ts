import type { ResourceType } from "../types.ts";
import { dirType } from "./dir.ts";
import { execType } from "./exec.ts";
import { fileType } from "./file.ts";
import { linkType } from "./link.ts";
import { aurType, pacmanType } from "./pacman.ts";
import { aptType } from "./apt.ts";
import { repoType } from "./repo.ts";
import { lineType } from "./line.ts";
import { unitType } from "./unit.ts";
import { groupType, memberType, userType } from "./account.ts";
import { triggerType } from "./trigger.ts";
import { flatpakType } from "./flatpak.ts";
import { kconfigType } from "./kconfig.ts";
import { gitType } from "./git.ts";

export const builtinTypes: ResourceType[] = [
  repoType,
  pacmanType,
  aurType,
  aptType,
  flatpakType,
  dirType,
  gitType,
  fileType,
  lineType,
  linkType,
  kconfigType,
  execType,
  groupType,
  userType,
  memberType,
  unitType,
  triggerType,
];

const KIND = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$/;

/** Problems with plugin types from defineConfig({ types }): bad or duplicate kinds, missing methods. */
export function checkTypes(plugins: readonly ResourceType[]): string[] {
  const problems: string[] = [];
  const seen = new Map(builtinTypes.map((t) => [t.kind, "built in"]));
  for (const t of plugins) {
    const kind = (t as Partial<ResourceType>)?.kind;
    if (typeof kind !== "string" || !KIND.test(kind)) {
      problems.push(`resource type ${JSON.stringify(kind)}: kind must look like "name" or "group:name" (lowercase)`);
      continue;
    }
    if (seen.has(kind)) problems.push(`resource type "${kind}" is defined twice (${seen.get(kind)} and in defineConfig({ types }))`);
    seen.set(kind, "in defineConfig({ types })");
    for (const m of ["scope", "id", "display", "equal", "read", "diff", "apply"] as const)
      if (typeof t[m] !== "function") problems.push(`resource type "${kind}": ${m} must be a function (build it with defineType)`);
  }
  for (const a of seen.keys())
    for (const b of seen.keys()) if (a !== b && b.startsWith(a + ":")) problems.push(`resource kinds "${a}" and "${b}" overlap: IDs of one would look like the other's`);
  return problems;
}

export function typeRegistry(plugins: readonly ResourceType[] = []) {
  const types = [...builtinTypes, ...plugins];
  // Longest kind first, so "pkg:pacman" wins over a hypothetical "pkg".
  const byKind = new Map([...types].sort((a, b) => b.kind.length - a.kind.length).map((t) => [t.kind, t]));
  return {
    all: types,
    get(kind: string): ResourceType {
      const t = byKind.get(kind);
      if (!t) throw new Error(`unknown resource kind: ${kind}`);
      return t;
    },
    /** Resource IDs are "<kind>:<rest>"; kinds may themselves contain a colon (pkg:pacman). */
    kindOf(id: string): string {
      for (const k of byKind.keys()) if (id.startsWith(k + ":")) return k;
      throw new Error(`unknown resource id: ${id}`);
    },
  };
}

export type TypeRegistry = ReturnType<typeof typeRegistry>;
