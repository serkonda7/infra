import { module } from "rig";

export const dev = module("dev", ({ pkg, link, file, exec, unit, user, git, facts, tmpl }) => {
  pkg(["neovim", "bun", "docker"]);
  pkg.aur(["visual-studio-code-bin"]);

  unit("docker", { started: true }); // ordered after the docker package
  user.groups(["docker"]);

  link("~/.config/nvim", "dotfiles/nvim"); // whole-dir symlink

  // Cloned if missing and kept at the tag; never pulled or reset over local work.
  git("~/src/neovim", "https://github.com/neovim/neovim.git", { ref: "v0.11.0" });

  const gitconfig = file(
    "~/.gitconfig",
    tmpl`
      [user]
        name = ${user.name}
        email = ${user.email}
      [core]
        editor = nvim
    `,
  );

  exec("git config --global --get core.editor >/dev/null && echo gitconfig ok", {
    onChange: [gitconfig],
    asUser: true,
  });

  if (facts.gpu.vendor === "nvidia") pkg(["nvidia-utils"]);
});
