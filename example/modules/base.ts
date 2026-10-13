import { module } from "rig";

export const base = module("base", (ctx) => {
  ctx.pkg(["git", "ripgrep", "fd", "fish", { arch: "base-devel", debian: "build-essential" }]);

  // stow-like: every file under dotfiles/home/ is linked into ~
  ctx.link.tree("dotfiles/home", "~", { ignore: ["**/local.fish"] });

  // pacman.conf belongs to the distro; only touch the lines we care about.
  if (ctx.facts.os.family === "arch") ctx.lineInFile("/etc/pacman.conf", { line: "Color", match: /^#?Color$/ });

  if (ctx.facts.boot.loader === "limine" || ctx.facts.boot.loader === "grub") ctx.kernelParams(["nowatchdog"]);
});
