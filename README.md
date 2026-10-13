# rig

Declarative machine and dotfile management in Bun + TypeScript. rig converges
a Linux machine (packages, system config, services, users, dotfiles) to the
state described by typed TypeScript modules:

- **Convergent.** Running `rig apply` twice changes nothing the second time.
- **Removal is first-class.** Delete a line from your config, and the file,
  unit or package it created goes away on the next apply.
- **Plan before apply.** Every run shows a Terraform-style diff first.
- **Just TypeScript.** Modules are functions, so conditionals, loops and reuse
  are plain TS with type-checking.
- **One binary.** Remote hosts need only SSH and sudo.

Arch/CachyOS first (pacman, AUR via paru, snapper), with Debian as a second
backend. The design rationale is in [`design.html`](design.html).

## Getting started

```sh
bun install
bun run build                 # → dist/rig (single binary, embeds Bun)
bun test                      # unit + integration tests against fake executors
```

A config repo (see [`example/`](example)) looks like this:

```
infra/
├── rig.config.ts       # hosts + defaults (+ plugin types)
├── hosts/zephyr.ts     # host({ os, modules, … })
├── modules/dev.ts      # module("dev", (ctx) => { … })
├── dotfiles/           # linked or copied into $HOME
├── secrets/            # age-encrypted, safe to commit
└── fixtures/           # saved facts for `rig plan --offline` (CI)
```

```ts
// rig.config.ts
import { defineConfig } from "rig";
export default defineConfig({
  hosts: { zephyr: () => import("./hosts/zephyr"), vault: () => import("./hosts/vault") },
  defaults: { user: "john", email: "john@example.com" },
});

// hosts/zephyr.ts
import { host } from "rig";
export default host({ os: "arch", modules: [base, dev, kde({ flatpaks: ["org.mozilla.firefox"] })] });

// modules/dev.ts
import { module } from "rig";
export const dev = module("dev", ({ pkg, link, unit, user, git, facts }) => {
  pkg(["neovim", "docker"]);
  pkg.aur(["visual-studio-code-bin"]);
  unit("docker", { started: true });
  user.groups(["docker"]);
  link("~/.config/nvim", "dotfiles/nvim");
  git("~/src/neovim", "https://github.com/neovim/neovim.git", { ref: "v0.11.0" });
  if (facts.gpu.vendor === "nvidia") pkg(["nvidia-utils"]);
});
```

`rig apply` with no host picks the host named after the machine's hostname.
Modules can be used bare (`dev`) or with options (`kde({ … })`). Every
resource remembers which module and line declared it (see `rig why`).

## Builders

Every builder registers resources and returns their IDs. Nothing runs until
apply. Pass IDs to `after` (or `onChange`, `on`, `restartOn`) to order things.

| Builder | Resource ID | Notes |
|---|---|---|
| `pkg(names)` | `pkg:pacman:…` / `pkg:apt:…` | One transaction per run. Cross-distro names: `{ arch, debian }`, plus a built-in alias table (`fd` → `fd-find`, …). |
| `pkg.aur(names)` | `pkg:aur:…` | Built by paru as your user. paru is bootstrapped from the repos. |
| `pkg.flatpak(appIds, { remote?, url? })` | `pkg:flatpak:…` | System-wide, from Flathub by default (the remote is added if missing). Installs the `flatpak` package first. |
| `pkg.repo(name, opts)` | `repo:pacman:…` / file | pacman.conf section + signing keys, or a deb822 apt source + keyring. |
| `file(path, content \| { source, mode })` | `file:<path>` | Atomic write. A pre-existing original is backed up and restored on removal. Secrets: 0600, redacted in plans. |
| `link(path, repoPath)`, `link.tree(dir, dest)` | `link:<path>` | Symlinks into the repo, stow-like for trees. |
| `dir(path, { mode })` | `dir:<path>` | Removed only if empty. |
| `lineInFile(path, line \| { line, match } \| { block, key })` | `line:<path>#<key>` | One line or a marker-delimited block in a file rig doesn't own. |
| `kconfig(file, { Group: { key: value } })` | `kcfg:<path>:<group>.<key>` | Individual KDE settings via `kwriteconfig6 --notify`. Bare names live in `~/.config`, and nested groups are written `"A][B"`. On removal the previous value is restored, unless Plasma has changed the key since. |
| `git(path, url, { ref?, prune? })` | `git:<path>` | Clones if missing and keeps `ref` checked out (a branch counts once it is current, and is never pulled). Refuses to switch over local changes. Clones are kept when undeclared, unless `prune: true` and nothing would be lost. |
| `exec(cmd, { unless, creates, onChange, undo, asUser })` | `exec:<hash>` | Guarded commands. Unguarded ones get a lint warning. |
| `unit(name, { enabled, started, user, restartOn })`, `unit.define(…)` | `unit:system\|user:…` | Only undoes what rig itself enabled or started. |
| `user(name, opts)`, `group(name, opts)`, `user.groups([…])` | `user:…`, `group:…`, `member:…` | Accounts are deleted only with `prune: true`. |
| `sysctl({ … })`, `kernelParams([…])` | file / line + trigger | Merged across modules. Applied with `sysctl --system` or by regenerating Limine/GRUB entries. |
| `trigger(cmd, { on })` | `trigger:<hash>` | Runs once at the end if anything it watches changed. |
| `secret(name)` | — | Decrypted `secrets/<name>.age`, usable in `file`/`tmpl` and never as a plain string. |
| `resource(type, spec)` | `<kind>:…` | A custom resource type, see [Plugins](#plugins). |

Context values: `facts` (distro, CPU level, GPU, root fs, boot loader, users,
…), `host`, `repo`, `user` (`name`, `home`, `email`), `vars` (from
`defaults.vars`), `tmpl` (a dedenting template tag), `include(...modules)`.

## Packages

- **additive** (default) installs what's declared and removes only packages
  rig installed and you've since undeclared.
- **exact** (`packages: { mode: "exact", keep: ["globs"] }`) also removes
  every undeclared explicitly-installed package (`--demote` marks them as
  dependencies instead). Flatpak apps are always additive.
- `rig adopt packages` writes your machine's explicit packages to
  `modules/_adopted/<host>-packages.ts` to start from.

## State, pruning and rollback

Live state is always re-read. A *generation*
(`~/.local/state/rig/hosts/<host>/generations/<n>.json`) records what rig owns
after each apply, along with the git commit and the snapper snapshot. The next
apply removes whatever an earlier generation owned that is no longer declared,
but only if it is still what rig left there. Files you edited block removal
until you pass `--force`.

```sh
rig gen ls                 # generations, with commit, snapshot, "rollback of n"
rig rollback 41            # re-apply generation 41's commit (temporary git worktree) as a new generation
rig gen gc --keep 10       # drop old generations and backups nothing refers to
```

Rollback evaluates the old commit, but links keep pointing into your working
copy. Content behind links is a git matter (`git checkout <commit> -- dotfiles/…`).
For system-level rollback, boot a snapper snapshot from the Limine menu.

## Remote hosts and secrets

A host with `connect: { ssh: "john@vault.lan" }` is applied over SSH. rig
uploads itself and a bundle of the config, evaluates on the target, and
streams the plan back, so `rig plan vault` looks just like a local run.
Changes that could cut the connection (sshd, firewall, network) are applied
last, behind a dead-man's switch.

Secrets are age files encrypted to `secrets/recipients` (your SSH/age keys and
each host's key): `rig secret edit <name>`, `rig secret rekey`, `rig secret ls`.

## CLI

| Command | |
|---|---|
| `rig plan [host]` | Show the diff. Exit code 2 if there are changes, 1 if something is blocked. |
| `rig plan [host] --offline [--facts <file>]` | Evaluate and validate only, against saved facts. No machine, no keys. |
| `rig apply [host] [-y]` | Plan → confirm → apply. `--only <glob>`, `--upgrade`, `--force`, `--demote`, `--no-snapshot`. |
| `rig dot` | Home-scoped resources only, with no sudo. Fast enough for a git hook. |
| `rig status [host]` | Current generation, drift, pending `.pacnew`/`.dpkg-dist` files, failed units. |
| `rig why <id\|path\|name> [host]` | Which module and line declared a resource, its dependency chain, and what needs it. |
| `rig adopt <path> [--module m]` | Move a dotfile into the repo and link it back. |
| `rig facts [host] [--save]` | Gathered facts as JSON. `--save` writes `fixtures/<host>.json` with the package lists. |
| `rig gen ls \| gc \| rollback <n>` | Generations. |
| `rig secret ls \| edit \| rekey` | Secrets. |

Global flags: `--json`, `-v`, `--config <dir>` (otherwise the nearest
`rig.config.ts` upwards, then `$RIG_CONFIG`, then `~/infra`).

## CI: offline plans

`rig plan --offline` runs the module code, checks for conflicts, cycles and
unknown dependencies, and validates package names against a cached package
list. It doesn't touch any machine and needs no secrets (it only checks that
they exist), so it works in CI:

```sh
rig facts zephyr --save          # once per host, on (or over SSH to) the host; commit fixtures/zephyr.json
rig plan zephyr --offline        # in CI: exit 0 if the config is sound, 1 with the problems otherwise
```

```yaml
# .github/workflows/rig.yml
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: curl -fsSL https://github.com/<you>/rig/releases/latest/download/rig-linux-x64 -o rig && chmod +x rig
      - run: for h in zephyr vault; do ./rig plan "$h" --offline || exit 1; done
```

Refresh a fixture when your repos change (`rig facts <host> --save`). Without
a package list, the offline plan skips package-name checks and warns.
`example/fixtures/` has two hand-trimmed fixtures. Real ones list every
package in the sync repos (a few hundred KB).

## Plugins

Custom resource types are plain objects implementing the same interface as
the built-ins. Register them in `defineConfig({ types: [...] })` and declare
them with `ctx.resource(type, spec)`. They get plans, generations, pruning and
`rig why` for free. See [docs/plugins.md](docs/plugins.md).

```ts
// rig.config.ts
export default defineConfig({ types: [greeting], hosts: { … } });

// modules/hello.ts — greeting = defineType({ kind: "greeting", scope, id, read, diff, apply, … })
export const hello = module("hello", ({ resource, user }) => {
  resource(greeting, { name: "world", text: "hi", dir: `${user.home}/.greetings` });
});
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
