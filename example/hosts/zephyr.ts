import { host } from "rig";
import { base } from "../modules/base";
import { dev } from "../modules/dev";
import { gaming } from "../modules/desktop/gaming";
import { kde } from "../modules/desktop/kde";

export default host({
  os: "arch", // family; CachyOS detected via facts
  packages: { mode: "additive" },
  modules: [base, dev, gaming({ steam: true, gamescope: true }), kde({ flatpaks: ["org.mozilla.firefox", "org.kde.krita"] })],
});
