// The plugin API: custom resource types are plain objects implementing
// ResourceType. Register them with defineConfig({ types: [...] }) and declare
// resources with ctx.resource(type, spec). See docs/plugins.md.

import type { ResourceBase, ResourceType } from "./types.ts";

/** Version of the ResourceType contract. Bumped only for breaking changes. */
export const PLUGIN_API_VERSION = 1;

/** What a plugin has to provide; the rest gets defaults (see defineType). */
export type TypeDefinition<Spec extends ResourceBase, Live, Meta> = Omit<ResourceType<Spec, Live, Meta>, "label" | "order" | "display" | "equal"> &
  Partial<Pick<ResourceType<Spec, Live, Meta>, "label" | "order" | "display" | "equal">>;

const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? Buffer.from(x).toString("base64") : x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/**
 * Define a resource type. Defaults: `label` is the kind, `order` 60 (after files, links and
 * commands, before units), `display` is the ID without its kind prefix, and two declarations
 * of the same ID are equal when their specs are deeply equal.
 */
export function defineType<Spec extends ResourceBase, Live = unknown, Meta = unknown>(def: TypeDefinition<Spec, Live, Meta>): ResourceType<Spec, Live, Meta> {
  return {
    label: def.kind,
    order: 60,
    display: (id) => id.slice(def.kind.length + 1),
    equal: (a, b) => stable({ ...a, after: undefined }) === stable({ ...b, after: undefined }),
    ...def,
  };
}
