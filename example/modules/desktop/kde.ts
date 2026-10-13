import { module } from "rig";

export const kde = module("kde", ({ pkg, kconfig }, opts: { flatpaks?: string[] } = {}) => {
  // Individual keys only: Plasma keeps owning the rest of these files.
  kconfig("kdeglobals", {
    General: { ColorScheme: "BreezeDark" },
    KDE: { SingleClick: false },
  });
  kconfig("kwinrc", {
    Plugins: { blurEnabled: true },
    "Effect-overview][Shortcuts": { Toggle: "Meta+W" }, // nested group [Effect-overview][Shortcuts]
  });

  // System-wide from Flathub; the flatpak package and the remote are set up first.
  if (opts.flatpaks?.length) pkg.flatpak(opts.flatpaks);
});
