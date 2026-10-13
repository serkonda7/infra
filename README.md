# rig
Declarative machine and dotfile management.


## Quick start
```sh
# 1. Dependencies
## Arch
sudo pacman -Syu --needed git curl 

## Debian
sudo apt update && sudo apt install -y git curl ca-certificates

# 2. rig binary
sudo curl -fsSL https://github.com/serkonda7/infra/releases/latest/download/rig-linux-x64 -o /usr/local/bin/rig
sudo chmod +x /usr/local/bin/rig

# 3. Your config
git clone https://github.com/<you>/<your-config>.git ~/dotfiles

# 4. Preview, then apply
rig plan <host>
rig apply <host>
```

`<host>` is a name from your `rig.config.ts` or empty if it already matches.

No config yet? Copy [`example/`](example) as a starting point.


## A taste
```ts
// modules/dev.ts
import { module } from "rig";
export const dev = module("dev", (ctx) => {
  ctx.pkg(["neovim", "docker"]);
  ctx.unit("docker", { started: true });
  ctx.user.groups(["docker"]);
  ctx.link("~/.config/nvim", "dotfiles/nvim");
  if (ctx.facts.gpu.vendor === "nvidia") ctx.pkg(["nvidia-utils"]);
});
```


## Documentation
- [Configuration](docs/configuration.md): repo layout, hosts, modules, builders, package modes
- [State, pruning and rollback](docs/state.md)
- [Remote hosts and secrets](docs/remote.md)
- [CLI](docs/cli.md)
- [CI: offline plans](docs/ci.md)
- [Writing resource types (plugins)](docs/plugins.md)

Building from source and the code layout: [CONTRIBUTING.md](CONTRIBUTING.md).
