# Configuration

A config repo (see [`example/`](../example)) looks like this:

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
export const dev = module("dev", (ctx) => {
  ctx.pkg(["neovim", "docker"]);
  ctx.pkg.aur(["visual-studio-code-bin"]);
  ctx.unit("docker", { started: true });
  ctx.user.groups(["docker"]);
  ctx.link("~/.config/nvim", "dotfiles/nvim");
  ctx.git("~/src/neovim", "https://github.com/neovim/neovim.git", { ref: "v0.11.0" });
  if (ctx.facts.gpu.vendor === "nvidia") ctx.pkg(["nvidia-utils"]);
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
| `pkg.remove(names)` | — | Removes these packages/Flatpak apps (globs) even if installed before rig; see [Packages](#packages). |
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
| `resource(type, spec)` | `<kind>:…` | A custom resource type, see [plugins](plugins.md). |

Context values: `facts` (distro, CPU level, GPU, root fs, boot loader, users,
…), `host`, `repo`, `user` (`name`, `home`, `email`), `vars` (from
`defaults.vars`), `tmpl` (a dedenting template tag), `include(...modules)`.

## Packages

- **additive** (default) installs what's declared and removes only packages
  rig installed and you've since undeclared.
- **exact** (`packages: { mode: "exact", keep: ["globs"] }`) also removes
  every undeclared explicitly-installed package (`--demote` marks them as
  dependencies instead). Flatpak apps are always additive.
- **remove** (`ctx.pkg.remove(["nano", "yay-*", "org.kde.krita"])` in a
  module, or `packages: { remove: [...] }` on the host) removes the listed
  explicitly-installed packages and Flatpak apps in either mode, including
  ones installed before rig. Declared packages win (with a
  warning), `base` is never removed, and `--demote` applies here too.
- `rig adopt packages` writes your machine's explicit packages to
  `modules/_adopted/<host>-packages.ts` to start from.

## Plugins

Custom resource types are plain objects implementing the same interface as
the built-ins. Register them in `defineConfig({ types: [...] })` and declare
them with `ctx.resource(type, spec)`. They get plans, generations, pruning and
`rig why` for free. See [plugins.md](plugins.md).

```ts
// rig.config.ts
export default defineConfig({ types: [greeting], hosts: { … } });

// modules/hello.ts — greeting = defineType({ kind: "greeting", scope, id, read, diff, apply, … })
export const hello = module("hello", (ctx) => {
  ctx.resource(greeting, { name: "world", text: "hi", dir: `${ctx.user.home}/.greetings` });
});
```
