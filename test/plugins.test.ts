import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { module } from "../src/config/define.ts";
import { defineType, pick, type ResourceBase, type Scope } from "../src/index.ts";
import { checkTypes } from "../src/resources/index.ts";
import { makeEnv, ops } from "./harness.ts";

// The example from docs/plugins.md: a greeting written into a file under ~/.greetings.
interface GreetingSpec extends ResourceBase {
  name: string;
  text: string;
  dir: string;
}

const greeting = defineType<GreetingSpec, { text: string }, { text: string }>({
  kind: "greeting",
  scope: (): Scope => "user",
  id: (s) => `greeting:${s.name}`,
  async read(items, x) {
    const out = new Map<string, { text: string } | null>();
    for (const { id, scope, spec, meta } of items) {
      const dir = spec?.dir ?? (meta as any).dir;
      const data = await pick(x, scope).readFile(join(dir, id.slice("greeting:".length)));
      out.set(id, data ? { text: new TextDecoder().decode(data) } : null);
    }
    return out;
  },
  diff(spec, live) {
    if (live?.text === spec.text) return { op: "noop", meta: { text: spec.text, dir: spec.dir } as any };
    return { op: "change", action: live ? "update" : "create" };
  },
  async apply(changes, x) {
    return Promise.all(
      changes.map(async (c) => {
        await pick(x, "user").writeFile(join(c.spec.dir, c.spec.name), new TextEncoder().encode(c.spec.text), 0o644);
        return { id: c.id, ok: true as const, meta: { text: c.spec.text, dir: c.spec.dir } as any };
      }),
    );
  },
  planDestroy: () => ({ op: "destroy" }),
  async destroy(items, x) {
    return Promise.all(
      items.map(async ({ id, meta }) => {
        await pick(x, "user").unlink(join((meta as any).dir, id.slice("greeting:".length)));
        return { id, ok: true as const, meta: null };
      }),
    );
  },
});

describe("plugin resource types", () => {
  test("declared with ctx.resource, planned, applied and pruned like built-ins", async () => {
    const env = makeEnv({ types: [greeting] });
    const dir = join(env.home, ".greetings");
    const m = (text: string) => module("hello", ({ resource }) => void resource(greeting, { name: "world", text, dir }));

    const r = await env.apply([m("hi")]);
    expect(ops(r.plan)).toEqual(["create greeting:world"]);
    expect(r.plan.items[0]!.display).toBe("world"); // defineType default: ID without the kind
    expect(r.plan.items[0]!.type.label).toBe("greeting");
    expect(readFileSync(join(dir, "world"), "utf8")).toBe("hi");
    expect(ops(await env.plan([m("hi")]))).toEqual([]);
    expect(ops(await env.plan([m("hello")]))).toEqual(["update greeting:world"]);

    await env.apply([]);
    expect(existsSync(join(dir, "world"))).toBe(false);
  });

  test("default equality merges identical declarations and reports different ones", () => {
    const env = makeEnv({ types: [greeting] });
    const spec = { name: "w", text: "a", dir: "/x" };
    const same = env.evalHost([module("a", ({ resource }) => void resource(greeting, spec)), module("b", ({ resource }) => void resource(greeting, { ...spec }, { after: [] }))]);
    expect(same.errors).toEqual([]);
    const diff = env.evalHost([module("a", ({ resource }) => void resource(greeting, spec)), module("b", ({ resource }) => void resource(greeting, { ...spec, text: "b" }))]);
    expect(diff.errors[0]).toContain("conflicting declarations of greeting:w");
  });

  test("unregistered types, bad IDs and bad kinds are reported", () => {
    const env = makeEnv();
    const g = env.evalHost([module("m", ({ resource }) => void resource(greeting, { name: "w", text: "", dir: "/x" }))]);
    expect(g.errors[0]).toContain('resource type "greeting" is not registered — add it to defineConfig({ types: [...] })');

    const sloppy = defineType<GreetingSpec>({ ...greeting, kind: "greet", id: (s: GreetingSpec) => s.name } as any);
    const g2 = makeEnv({ types: [sloppy] }).evalHost([module("m", ({ resource }) => void resource(sloppy, { name: "w", text: "", dir: "/x" }))]);
    expect(g2.errors[0]).toContain('produced the ID "w"; IDs must start with "greet:"');

    expect(checkTypes([greeting, greeting])).toEqual([expect.stringContaining('"greeting" is defined twice')]);
    expect(checkTypes([{ ...greeting, kind: "file" }])).toEqual([expect.stringContaining('"file" is defined twice (built in')]);
    expect(checkTypes([{ ...greeting, kind: "pkg" }])).toContainEqual(expect.stringContaining('"pkg" and "pkg:pacman" overlap'));
    expect(checkTypes([{ ...greeting, kind: "Bad Kind" }])).toEqual([expect.stringContaining("kind must look like")]);
  });
});
