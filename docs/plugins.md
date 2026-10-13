# Writing resource types (plugins)

Everything rig manages is a **resource type**: a plain TypeScript object that
knows how to read, diff, apply and destroy one kind of thing. The built-in
types (`file`, `pkg:pacman`, `unit`, …) use exactly the interface described
here, so your own types work the same way. They show up in plans, get recorded
in generations, are pruned when you stop declaring them, and can be explained
by `rig why`.

The contract is stable as of `PLUGIN_API_VERSION = 1`. Breaking changes bump
that number.

## Overview

```ts
// rig.config.ts
import { defineConfig } from "rig";
import { greeting } from "./types/greeting";

export default defineConfig({
  types: [greeting],          // register, so rig can also *remove* greetings later
  hosts: { zephyr: () => import("./hosts/zephyr") },
});
```

```ts
// modules/hello.ts
import { module } from "rig";
import { greeting } from "../types/greeting";

export const hello = module("hello", (ctx) => {
  ctx.resource(greeting, { name: "world", text: "hi", dir: `${ctx.user.home}/.greetings` });
});
```

Keep a type registered as long as any generation might still own resources of
its kind. If you unregister it first, rig can't plan their removal and reports
`unknown resource kind`.

## A complete type

```ts
// types/greeting.ts
import { defineType, pick, type ResourceBase } from "rig";
import { join } from "node:path";

interface Spec extends ResourceBase { name: string; text: string; dir: string }
interface Live { text: string }
interface Meta { text: string; dir: string }

export const greeting = defineType<Spec, Live, Meta>({
  kind: "greeting",                         // IDs are "greeting:<something>"
  scope: () => "user",                      // "system" goes through the sudo helper
  id: (s) => `greeting:${s.name}`,

  // Batched: called once per kind with every declared ID (spec set) and every
  // ID only being destroyed (meta set, from the last generation).
  async read(items, x) {
    const out = new Map<string, Live | null>();
    for (const { id, scope, spec, meta } of items) {
      const dir = spec?.dir ?? meta!.dir;
      const data = await pick(x, scope).readFile(join(dir, id.slice("greeting:".length)));
      out.set(id, data ? { text: new TextDecoder().decode(data) } : null);
    }
    return out;
  },

  // Pure: no I/O. "noop" carries the meta to record; "blocked" refuses with a reason.
  diff(spec, live) {
    if (live?.text === spec.text) return { op: "noop", meta: { text: spec.text, dir: spec.dir } };
    return { op: "change", action: live ? "update" : "create", note: live ? "text changed" : undefined };
  },

  // Batched: one Result per change, in any order. Never throw for a single item.
  async apply(changes, x) {
    return Promise.all(changes.map(async (c) => {
      try {
        await pick(x, "user").writeFile(join(c.spec.dir, c.spec.name), new TextEncoder().encode(c.spec.text), 0o644);
        return { id: c.id, ok: true as const, meta: { text: c.spec.text, dir: c.spec.dir } };
      } catch (e) {
        return { id: c.id, ok: false as const, error: String(e) };
      }
    }));
  },

  // Optional. Without planDestroy/destroy, undeclared resources are just forgotten.
  planDestroy: (_id, meta, live) =>
    !live ? { op: "forget", note: "already gone" }
    : live.text !== meta.text ? { op: "blocked", reason: "edited since rig wrote it" }
    : { op: "destroy" },

  async destroy(items, x) {
    return Promise.all(items.map(async ({ id, scope, meta }) => {
      await pick(x, scope).unlink(join(meta.dir, id.slice("greeting:".length)));
      return { id, ok: true as const, meta: null };
    }));
  },
});
```

## The interface

`defineType` takes a `ResourceType` and fills in defaults for the optional
presentation fields. All types are exported from `rig`.

| Member | Required | Purpose |
|---|---|---|
| `kind` | yes | `name` or `group:name`, lowercase. Must not collide or overlap with another kind (`pkg` would overlap `pkg:pacman`). |
| `scope(spec)` | yes | `"user"` or `"system"`. Decides the executor, whether `rig dot` touches the resource, and whether apply needs sudo. |
| `id(spec)` | yes | Stable identity, starting with `<kind>:`. Two declarations with the same ID are merged or reported as a conflict. |
| `read(items, x)` | yes | Batched read of live state. Return `null` for "doesn't exist". Must not change anything. |
| `diff(spec, live, prevMeta, ctx)` | yes | Pure. Returns `change` (`create`/`update`/`run`), `noop` (with the meta to record), or `blocked`. `ctx.changed` holds IDs that change earlier in this plan. `ctx.force` is `--force`. |
| `apply(changes, x, ctx)` | yes | Batched. Return one `Result` per change. The `meta` you return is stored in the generation and handed back as `prevMeta` / to `destroy`. |
| `planDestroy(id, meta, live, ctx)` | no | Decide what to do when the resource is no longer declared: `destroy`, `forget` (drop ownership, leave it) or `blocked`. Default: forget. |
| `destroy(items, x, ctx)` | no | Batched removal. Needed when `planDestroy` can return `destroy`. |
| `label` | no | Section heading in plan output. Default: the kind. |
| `order` | no | Order within one dependency level, lower first. Built-ins: packages 0–2, dirs 10, git 15, files 20, file edits 25, links 30, KDE 35, commands 40, accounts 45, services 50, triggers 90. Default: 60. |
| `display(id, spec?, paths)` | no | Human name in plans. `spec` is missing for destroys. Default: the ID without `kind:`. |
| `equal(a, b)` | no | Whether two declarations of one ID agree. Default: deep equality (ignoring `after`). |
| `merge(a, b)` | no | Union two declarations instead (return a string to report a conflict). |
| `edges(spec)` | no | Implicit dependencies (resource IDs). |
| `afterPackages` | no | Also depend on every package declared by the same module. |
| `deferred` | no | Apply at the very end of a run, like triggers. |
| `validate(specs, ctx)` | no | Plan-time checks over all declarations of this kind; return error strings. |
| `extraneous(opts, x)` | no | Exact mode: live resources of this kind that aren't declared and should be pruned (package managers). |

### Executors

All I/O goes through an `Executor` (`x.user` / `x.system`; `pick(x, scope)`
chooses one). This keeps types testable and lets system changes run through
the privileged helper:

- `run(argv, { cwd, env, stdin, stream })` returns `{ code, stdout, stderr }`. It never uses a
  shell, so call `["sh", "-c", …]` yourself if you need one. A missing binary throws.
- `readFile`, `lstat`, `readlink` return `null` when the path is missing.
- `writeFile` (atomic, creates parent directories), `chmod`, `symlink` (atomic replace), `mkdirp`,
  `rename`, `unlink`, `rmdir`.

Read state as the user where you can (`x.user`). `x.system` reads fall back
to sudo only on `EACCES`, so plans stay password-free.

### Rules that keep rig safe

- **`read` and `diff` never change anything.** `rig plan`, `rig status` and
  CI depend on that.
- **Re-read, don't trust meta.** Meta records what rig did (to undo it or to
  detect edits). It is not a cache of live state.
- **Only remove what you created.** Record in meta whether rig created
  something, or whether it existed before. Use that in `planDestroy` to
  `forget` things that were there first, and to `block` on things the user
  changed since.
- **One result per item.** If a batch fails as a whole, retry items one by one
  where that makes sense (see `pkg:pacman`).

### Testing

`FakeExecutor` (`src/exec/fake.ts`) records commands and answers them through
handlers, while file operations hit a temp directory. `test/plugins.test.ts`
runs the example above through plan, apply and prune.
