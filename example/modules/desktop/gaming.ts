import { module } from "rig";

export const gaming = module("gaming", (ctx, opts: { steam?: boolean; gamescope?: boolean } = {}) => {
  ctx.pkg(["mangohud"]);
  if (opts.steam) ctx.pkg(["steam"]);
  if (opts.gamescope) ctx.pkg(["gamescope"]);
  ctx.sysctl({ "vm.max_map_count": 2147483642 }); // merged into /etc/sysctl.d/90-rig.conf, applied with sysctl --system
});
