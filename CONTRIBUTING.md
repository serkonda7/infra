# Contributing

## Quick-start (build from source)

```sh
# 1. Prerequisites: git + Bun 1.4.3 (pinned in package.json `packageManager`)
curl -fsSL https://bun.sh/install | bash
git clone https://github.com/serkonda7/infra.git
cd infra

# 2. Install deps, build and symlink
bun install
bun run build                 # → dist/rig
sudo ln -sf "$PWD/dist/rig" /usr/local/bin/rig

# 3. Run checks
bun test                      # unit + integration tests against fake executors
bun run typecheck
```

No build needed for day-to-day work — run directly from source:

```sh
bun src/cli/main.ts --help
# or via the alias: bun run rig --help
```

## Building and testing

```sh
bun install
bun run build                 # → dist/rig (single binary, embeds Bun)
bun test                      # unit + integration tests against fake executors
bun run rig --help            # run from source
```

## Layout

```
src/
├── cli/        commands, terminal/NDJSON sessions, why/status/rollback
├── config/     defineConfig, host(), module(), the evaluation context
├── engine.ts   load → facts → evaluate → validate → plan
├── facts/      local facts
├── graph/      registry, merging, implicit edges, toposort
├── plan/       differ, plan rendering
├── apply/      batched apply, triggers, snapshots, dead-man's switch
├── state/      generations, object store, gc
├── exec/       executors: local, sudo helper, fake (tests)
├── resources/  one file per resource type
├── remote/     SSH transport, bundles, binary cache
├── secrets/    age, Secret values
├── helper/     the privileged NDJSON helper (`sudo rig __helper`)
└── plugin.ts   defineType, PLUGIN_API_VERSION
```
