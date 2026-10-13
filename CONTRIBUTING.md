# Contributing

## Building and testing

```sh
bun install
bun run build                 # → dist/rig (single binary, embeds Bun)
bun test                      # unit + integration tests against fake executors
bun run rig plan --config example zephyr --offline   # run from source
```

## Layout

```
src/
├── cli/        commands, terminal/NDJSON sessions, why/status/rollback
├── config/     defineConfig, host(), module(), the evaluation context
├── engine.ts   load → facts → evaluate → validate → plan; offline check
├── facts/      local facts, fixtures for offline plans
├── graph/      registry, merging, implicit edges, toposort
├── plan/       differ, plan rendering
├── apply/      batched apply, triggers, snapshots, dead-man's switch
├── state/      generations, object store, gc
├── exec/       executors: local, sudo helper, fake (tests), offline
├── resources/  one file per resource type
├── remote/     SSH transport, bundles, binary cache
├── secrets/    age, Secret values
├── helper/     the privileged NDJSON helper (`sudo rig __helper`)
└── plugin.ts   defineType, PLUGIN_API_VERSION
```
