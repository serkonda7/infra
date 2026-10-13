import { module } from "rig";

export const dev = module("dev", (ctx) => {
  ctx.pkg(["neovim", "bun", "docker"]);
  ctx.pkg.aur(["visual-studio-code-bin"]);

  ctx.unit("docker", { started: true }); // ordered after the docker package
  ctx.user.groups(["docker"]);

  ctx.link("~/.config/nvim", "dotfiles/nvim"); // whole-dir symlink

  // Cloned if missing and kept at the tag; never pulled or reset over local work.
  ctx.git("~/src/neovim", "https://github.com/neovim/neovim.git", { ref: "v0.11.0" });

  const gitconfig = ctx.file(
    "~/.gitconfig",
    ctx.tmpl`
      [user]
        name = ${ctx.user.name}
        email = ${ctx.user.email}
      [core]
        editor = nvim
    `,
  );

  ctx.exec("git config --global --get core.editor >/dev/null && echo gitconfig ok", {
    onChange: [gitconfig],
    asUser: true,
  });

  if (ctx.facts.gpu.vendor === "nvidia") ctx.pkg(["nvidia-utils"]);
});
