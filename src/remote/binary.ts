// The rig binary that runs on the target: this very binary when the
// architecture matches, otherwise (from source) one compiled for the target,
// cached locally and uploaded once per version to ~/.cache/rig/bin/.

import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, arch as osArch } from "node:os";
import { join } from "node:path";
import { spawn } from "../exec/local.ts";
import type { Ssh } from "./ssh.ts";

const BUN_TARGET: Record<string, string> = { x86_64: "linux-x64", aarch64: "linux-arm64" };
const localMachine = () => ({ x64: "x86_64", arm64: "aarch64" })[osArch() as "x64" | "arm64"] ?? osArch();
const isCompiled = () => import.meta.path.startsWith("/$bunfs/");
const SRC = join(import.meta.dir, "..");

const cacheDir = () => join(process.env.XDG_CACHE_HOME || join(process.env.HOME || homedir(), ".cache"), "rig");

const short = (data: Uint8Array | string) => Bun.hash.xxHash3(data).toString(16).padStart(16, "0");

/** Identifies the source tree (and dependencies) a binary would be compiled from. */
async function sourceHash(): Promise<string> {
  const parts: string[] = [Bun.version];
  for await (const f of new Bun.Glob("**/*.ts").scan({ cwd: SRC, onlyFiles: true })) parts.push(f);
  parts.sort();
  const contents = await Promise.all(parts.slice(1).map((f) => Bun.file(join(SRC, f)).text()));
  const lock = join(SRC, "../bun.lock");
  return short(parts.join("\0") + contents.join("\0") + (existsSync(lock) ? await Bun.file(lock).text() : ""));
}

export interface LocalBinary {
  path: string;
  /** Content hash: the remote file name, so each version is uploaded once. */
  hash: string;
  size: number;
}

/** A rig binary for `machine` (uname -m). `baseline`: the target CPU lacks AVX2. */
export async function localBinary(machine: string, baseline: boolean, info: (m: string) => void): Promise<LocalBinary> {
  const target = BUN_TARGET[machine];
  if (!target) throw new Error(`unsupported remote architecture ${machine} (supported: ${Object.keys(BUN_TARGET).join(", ")})`);
  let path: string;
  if (isCompiled()) {
    if (machine !== localMachine())
      throw new Error(`this rig binary is ${localMachine()} and can't build one for a ${machine} host; run rig from source to cross-compile`);
    path = process.execPath;
  } else {
    const bunTarget = `bun-${target}${baseline && machine === "x86_64" ? "-baseline" : ""}`;
    path = join(cacheDir(), "bin", `rig-${await sourceHash()}-${bunTarget}`);
    if (!existsSync(path)) {
      info(`compiling rig for ${bunTarget} …`);
      await fs.mkdir(join(cacheDir(), "bin"), { recursive: true });
      const tmp = `${path}.tmp-${process.pid}`;
      const r = await spawn([process.execPath, "build", "--compile", "--minify", `--target=${bunTarget}`, join(SRC, "cli/main.ts"), "--outfile", tmp]);
      if (r.code !== 0) throw new Error(`bun build --compile failed:\n${(r.stderr || r.stdout).trim()}`);
      await fs.rename(tmp, path);
    }
  }
  const data = new Uint8Array(await Bun.file(path).arrayBuffer());
  return { path, hash: short(data), size: data.length };
}

/** Upload the binary unless the target already has this exact version. Returns its remote path. */
export async function ensureRemoteBinary(ssh: Ssh, bin: LocalBinary, remoteHome: string, info: (m: string) => void): Promise<string> {
  const remote = `${remoteHome}/.cache/rig/bin/rig-${bin.hash}`;
  if ((await ssh.run(["test", "-x", remote])).code === 0) return remote;
  info(`uploading rig to ${ssh.target} (${(bin.size / 1e6).toFixed(0)} MB) …`);
  const script = 'mkdir -p "${1%/*}" && cat > "$1.tmp" && chmod 755 "$1.tmp" && mv -f "$1.tmp" "$1"';
  const r = await ssh.run(["sh", "-c", script, "sh", remote], new Uint8Array(await Bun.file(bin.path).arrayBuffer()));
  if (r.code !== 0) throw new Error(`uploading rig failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  return remote;
}
