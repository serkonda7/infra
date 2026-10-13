# CLI

| Command | |
|---|---|
| `rig plan [host]` | Show the diff. Exit code 2 if there are changes, 1 if something is blocked. |
| `rig apply [host] [-y]` | Plan → confirm → apply. `--only <glob>`, `--upgrade`, `--force`, `--demote`, `--no-snapshot`. |
| `rig dot` | Home-scoped resources only, with no sudo. Fast enough for a git hook. |
| `rig status [host]` | Current generation, drift, pending `.pacnew`/`.dpkg-dist` files, failed units. |
| `rig why <id\|path\|name> [host]` | Which module and line declared a resource, its dependency chain, and what needs it. |
| `rig adopt <path> [--module m]` | Move a dotfile into the repo and link it back. |
| `rig facts [host]` | Gathered facts as JSON. |
| `rig gen ls \| gc \| rollback <n>` | Generations. |
| `rig secret ls \| edit \| rekey` | Secrets. |

Global flags: `--json`, `-v`, `--config <dir>` (otherwise the nearest
`rig.config.ts` upwards, then `$RIG_CONFIG`, then `~/infra`).
