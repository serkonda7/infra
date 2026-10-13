import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as api from "../index.ts";
import { isConfig, type ConfigDef } from "./define.ts";

export const CONFIG_FILE = "rig.config.ts";

let registered = false;

/**
 * Make `import … from "rig"` inside the user's config resolve to this very
 * copy of rig — works for the compiled binary, where no node_modules exist.
 */
function registerRigModule() {
  if (registered) return;
  registered = true;
  Bun.plugin({
    name: "rig-self",
    setup(build) {
      build.module("rig", () => ({ exports: { ...api }, loader: "object" }));
    },
  });
}

export function findConfigDir(explicit: string | undefined, home: string): string {
  if (explicit) {
    const dir = resolve(explicit);
    if (!existsSync(join(dir, CONFIG_FILE))) throw new Error(`no ${CONFIG_FILE} in ${dir}`);
    return dir;
  }
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, CONFIG_FILE))) return dir;
    if (dirname(dir) === dir) break;
  }
  for (const dir of [process.env.RIG_CONFIG, join(home, "infra")]) {
    if (dir && existsSync(join(dir, CONFIG_FILE))) return resolve(dir);
  }
  throw new Error(`could not find ${CONFIG_FILE} (searched upwards from ${process.cwd()}, $RIG_CONFIG and ~/infra); use --config <dir>`);
}

/** `file` is the entry inside `dir`: rig.config.ts, or the bundled config of a remote run. */
export async function loadConfig(dir: string, file = CONFIG_FILE): Promise<ConfigDef> {
  registerRigModule();
  const mod = await import(join(dir, file));
  if (!isConfig(mod.default)) throw new Error(`${CONFIG_FILE} must \`export default defineConfig({...})\``);
  return mod.default;
}
