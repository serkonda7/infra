import { module } from "rig";

export const kde = module("kde", (ctx, opts: { flatpaks?: string[] } = {}) => {
  // Individual keys only: Plasma keeps owning the rest of these files.
  ctx.kconfig("kdeglobals", {
    General: { ColorScheme: "BreezeDark" },
    KDE: { SingleClick: false },
  });
  ctx.kconfig("kwinrc", {
    Plugins: { blurEnabled: true },
    "Effect-overview][Shortcuts": { Toggle: "Meta+W" }, // nested group [Effect-overview][Shortcuts]
  });

  // System-wide from Flathub; the flatpak package and the remote are set up first.
  if (opts.flatpaks?.length) ctx.pkg.flatpak(opts.flatpaks);
});
