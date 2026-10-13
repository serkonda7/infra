// Filesystem snapshots around applies that touch the system, so a broken
// boot can be rolled back from the boot menu (Limine + snapper on CachyOS).

import type { Executor, Facts } from "../types.ts";

export type SnapshotSetting = "auto" | "snapper" | "btrfs" | "none";

export interface Snapshotter {
  mode: "snapper" | "btrfs";
  /** Take the "before" snapshot; returns its reference for the generation record. */
  pre(description: string): Promise<string>;
  /** Close the pair (snapper only). */
  post(description: string): Promise<void>;
}

const BTRFS_DIR = "/.rig-snapshots";

/** Pick the snapshot backend. "auto" uses snapper when root is btrfs and a snapper "root" config exists. */
export async function snapshotter(setting: SnapshotSetting, facts: Facts, x: Executor): Promise<Snapshotter | null> {
  if (setting === "none") return null;
  const hasSnapper = facts.rootfs === "btrfs" && (await x.run(["sh", "-c", "command -v snapper >/dev/null && test -f /etc/snapper/configs/root"])).code === 0;
  let mode: "snapper" | "btrfs";
  if (setting === "auto") {
    if (!hasSnapper) return null;
    mode = "snapper";
  } else if (setting === "snapper") {
    if (!hasSnapper) throw new Error(`snapshots: "snapper" needs a btrfs root and a snapper "root" config (or set snapshots: "none")`);
    mode = "snapper";
  } else {
    if (facts.rootfs !== "btrfs") throw new Error(`snapshots: "btrfs" needs a btrfs root filesystem (this one is ${facts.rootfs})`);
    mode = "btrfs";
  }

  let preNumber: string | null = null;
  return {
    mode,
    async pre(description) {
      if (mode === "snapper") {
        const r = await x.run(["snapper", "-c", "root", "create", "--type", "pre", "--print-number", "--cleanup-algorithm", "number", "--description", description]);
        if (r.code !== 0) throw new Error(`snapper pre snapshot failed: ${r.stderr.trim()}`);
        preNumber = r.stdout.trim();
        return `snapper:#${preNumber}`;
      }
      const path = `${BTRFS_DIR}/${new Date().toISOString().replace(/[:.]/g, "-")}`;
      await x.mkdirp(BTRFS_DIR, 0o700);
      const r = await x.run(["btrfs", "subvolume", "snapshot", "-r", "/", path]);
      if (r.code !== 0) throw new Error(`btrfs snapshot failed: ${r.stderr.trim()}`);
      return `btrfs:${path}`;
    },
    async post(description) {
      if (mode !== "snapper" || !preNumber) return;
      const r = await x.run(["snapper", "-c", "root", "create", "--type", "post", "--pre-number", preNumber, "--cleanup-algorithm", "number", "--description", description]);
      if (r.code !== 0) throw new Error(`snapper post snapshot failed: ${r.stderr.trim()}`);
    },
  };
}
