// Dead-man's switch for remote applies. Changes that can cut the SSH
// connection (sshd config, firewall, network) run last. Before they do, rig
// saves what they touch, writes a revert script and schedules it with
// `systemd-run --on-active`. The controller then proves a *fresh* SSH login
// works; only then is the timer cancelled. If the login fails, the revert
// runs at once; if the connection is gone, the timer runs it.

import type { Executor } from "../types.ts";
import type { ChangeItem } from "./apply.ts";
import type { UnitLive, UnitSpec } from "../resources/unit.ts";
import { idPath } from "../resources/util.ts";

/** System paths whose change can lock us out, matched anywhere in the path (tests use a fake root). */
const RISKY_PATHS: [RegExp, string[]][] = [
  [/\/etc\/ssh\//, ["systemctl try-reload-or-restart ssh.service sshd.service"]],
  [/\/etc\/(nftables\.conf|nftables\.d\/|nftables\/)/, ["systemctl try-restart nftables.service"]],
  [/\/etc\/iptables\//, ["systemctl try-restart iptables.service ip6tables.service netfilter-persistent.service"]],
  [/\/etc\/ufw\//, ["systemctl try-restart ufw.service"]],
  [/\/etc\/firewalld\//, ["systemctl try-reload-or-restart firewalld.service"]],
  [/\/etc\/(network\/|systemd\/network\/|netplan\/|NetworkManager\/)/, ["systemctl try-restart networking.service systemd-networkd.service NetworkManager.service"]],
  [/\/etc\/hosts\.(allow|deny)$/, []],
];

const RISKY_UNITS = /^(ssh|sshd|nftables|iptables|ip6tables|netfilter-persistent|ufw|firewalld|networking|systemd-networkd|NetworkManager)\.(service|socket)$/;

const PATH_KINDS = new Set(["file", "link", "dir", "line"]);
/** "line:/etc/ssh/sshd_config#key" → "/etc/ssh/sshd_config" */
const pathOfItem = (i: ChangeItem) => (i.type.kind === "line" ? i.id.slice("line:".length, i.id.indexOf("#")) : idPath(i.id));
const unitOf = (i: ChangeItem) => i.change.spec as UnitSpec;

export function isRisky(i: ChangeItem): boolean {
  if (i.scope !== "system") return false;
  if (PATH_KINDS.has(i.type.kind)) return RISKY_PATHS.some(([re]) => re.test(pathOfItem(i)));
  if (i.type.kind === "unit") return !unitOf(i).user && RISKY_UNITS.test(unitOf(i).name);
  return false;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const ENABLED = new Set(["enabled", "enabled-runtime", "linked", "linked-runtime", "alias"]);
const RUNNING = new Set(["active", "reloading", "activating"]);

export class DeadMan {
  private armed: { unit: string; dir: string } | null = null;

  constructor(
    private readonly x: Executor,
    /** Seconds until the revert runs unless cancelled. */
    readonly seconds = 120,
    private readonly baseDir = "/var/lib/rig/deadman",
  ) {}

  get isArmed() {
    return !!this.armed;
  }

  /** Save the state of everything `items` touch, write the revert script and start the timer. */
  async arm(items: ChangeItem[]): Promise<void> {
    if (this.armed) throw new Error("dead-man's switch is already armed");
    const unit = `rig-deadman-${Date.now()}`;
    const dir = `${this.baseDir}/${unit}`;
    await this.x.mkdirp(dir, 0o700);

    const restore: string[] = [];
    const reload = new Set<string>();
    let n = 0;
    for (const path of [...new Set(items.filter((i) => PATH_KINDS.has(i.type.kind)).map(pathOfItem))]) {
      for (const [re, cmds] of RISKY_PATHS) if (re.test(path)) cmds.forEach((c) => reload.add(c));
      const st = await this.x.lstat(path);
      if (!st) restore.push(`rm -f -- ${q(path)}`);
      else if (st.type === "symlink") restore.push(`ln -sfn -- ${q((await this.x.readlink(path)) ?? "")} ${q(path)}`);
      else if (st.type === "file") {
        const saved = `${dir}/${n++}`;
        await this.x.writeFile(saved, (await this.x.readFile(path)) ?? new Uint8Array(), st.mode);
        // cp -p keeps the saved mode; rename keeps the swap atomic for readers like sshd.
        restore.push(`cp -p -- ${q(saved)} ${q(path)}.rig-revert && mv -f -- ${q(path)}.rig-revert ${q(path)}`);
      }
      // Directories: nothing to restore; files inside them are covered on their own.
    }
    for (const i of items.filter((i) => i.type.kind === "unit")) {
      const { name } = unitOf(i);
      const live = i.change.live as UnitLive | null;
      if (!live) restore.push(`systemctl disable --now -- ${q(name)}`);
      else {
        restore.push(`systemctl ${ENABLED.has(live.state) ? "enable" : "disable"} -- ${q(name)}`);
        restore.push(`systemctl ${RUNNING.has(live.active) ? "restart" : "stop"} -- ${q(name)}`);
      }
    }

    const script = [
      "#!/bin/sh",
      "# Written by rig: reverts connection-critical changes because the run did not confirm a fresh SSH login.",
      `logger -t rig "dead-man's switch fired: reverting ${items.length} change(s)" 2>/dev/null`,
      ...restore,
      "systemctl daemon-reload",
      ...reload,
      `rm -rf -- ${q(dir)}`,
      "",
    ].join("\n");
    await this.x.writeFile(`${dir}/revert.sh`, new TextEncoder().encode(script), 0o700);

    const r = await this.x.run(["systemd-run", `--unit=${unit}`, `--on-active=${this.seconds}s`, "--description=rig dead-man's switch", "/bin/sh", `${dir}/revert.sh`]);
    if (r.code !== 0) {
      await this.x.run(["rm", "-rf", "--", dir]);
      throw new Error(`systemd-run failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
    this.armed = { unit, dir };
  }

  /** The new configuration works: cancel the revert. */
  async disarm(): Promise<void> {
    if (!this.armed) return;
    const { unit, dir } = this.armed;
    const r = await this.x.run(["systemctl", "stop", "--", `${unit}.timer`]);
    if (r.code !== 0) throw new Error(`could not cancel the dead-man's switch (${unit}.timer): ${r.stderr.trim()}`);
    await this.x.run(["rm", "-rf", "--", dir]);
    this.armed = null;
  }

  /** The new configuration doesn't work: revert now instead of waiting for the timer. */
  async fire(): Promise<void> {
    if (!this.armed) return;
    const { unit, dir } = this.armed;
    await this.x.run(["systemctl", "stop", "--", `${unit}.timer`]);
    const r = await this.x.run(["/bin/sh", `${dir}/revert.sh`]);
    this.armed = null;
    if (r.code !== 0) throw new Error(`revert script failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }
}
