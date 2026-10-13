// Agentless SSH transport: one multiplexed connection (ControlMaster) per run.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { spawn } from "../exec/local.ts";
import type { HostDef } from "../config/define.ts";
import type { RunResult } from "../types.ts";

/** Quote one argument for the remote shell. */
export const shq = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

export class Ssh {
  /** $RIG_SSH replaces the ssh binary (tests use a fake that runs commands locally). */
  private readonly bin = process.env.RIG_SSH || "ssh";
  private readonly controlPath: string;

  constructor(readonly connect: NonNullable<HostDef["connect"]>) {
    const dir = join(process.env.XDG_CACHE_HOME || join(process.env.HOME || homedir(), ".cache"), "rig/ssh");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.controlPath = join(dir, "%C");
  }

  get target() {
    return this.connect.ssh;
  }

  private opts(mux: boolean): string[] {
    const o = mux ? ["-o", "ControlMaster=auto", "-o", `ControlPath=${this.controlPath}`, "-o", "ControlPersist=60"] : ["-o", "ControlMaster=no", "-o", "ControlPath=none"];
    return ["-T", ...o, ...(this.connect.port ? ["-p", String(this.connect.port)] : [])];
  }

  argv(cmd: string[], mux = true): string[] {
    return [this.bin, ...this.opts(mux), this.connect.ssh, "--", cmd.map(shq).join(" ")];
  }

  run(cmd: string[], stdin?: Uint8Array): Promise<RunResult> {
    return spawn(this.argv(cmd), { stdin });
  }

  /** A long-running remote command with piped stdin/stdout; its stderr goes straight to ours. */
  spawn(cmd: string[]): Subprocess<"pipe", "pipe", "inherit"> {
    return Bun.spawn(this.argv(cmd), { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  }

  /** Open a brand-new connection (bypassing the multiplexed one) — proves sshd still accepts logins. */
  async fresh(): Promise<boolean> {
    const argv = [this.bin, ...this.opts(false), "-o", "ConnectTimeout=20", this.connect.ssh, "--", "true"];
    const proc = Bun.spawn(argv, { stdin: "inherit", stdout: "ignore", stderr: "inherit" });
    return (await proc.exited) === 0;
  }

  /** Stop the master connection now instead of letting it linger for ControlPersist. */
  async close() {
    if (this.bin !== "ssh") return;
    await spawn([this.bin, "-o", `ControlPath=${this.controlPath}`, "-O", "exit", this.connect.ssh]).catch(() => {});
  }
}
