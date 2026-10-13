import { module } from "rig";

export const base = module("base", ({ pkg, link, lineInFile, facts, kernelParams }) => {
  pkg(["git", "ripgrep", "fd", "fish", { arch: "base-devel", debian: "build-essential" }]);

  // stow-like: every file under dotfiles/home/ is linked into ~
  link.tree("dotfiles/home", "~", { ignore: ["**/local.fish"] });

  // pacman.conf belongs to the distro; only touch the lines we care about.
  if (facts.os.family === "arch") lineInFile("/etc/pacman.conf", { line: "Color", match: /^#?Color$/ });

  if (facts.boot.loader === "limine" || facts.boot.loader === "grub") kernelParams(["nowatchdog"]);
});
