import * as fs from "node:fs/promises";
import { dirname } from "node:path";
import type { Executor, RunOptions, RunResult, Stat, StatType } from "../types.ts";

const typeOf = (s: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): StatType =>
  s.isSymbolicLink() ? "symlink" : s.isFile() ? "file" : s.isDirectory() ? "dir" : "other";

const isErr = (e: unknown, ...codes: string[]) => codes.includes((e as NodeJS.ErrnoException)?.code ?? "");

/** Where streamed child output goes. The privileged helper uses stderr: its stdout is the RPC channel. */
let streamTarget: "inherit" | 2 = "inherit";
export const streamToStderr = () => void (streamTarget = 2);

export async function spawn(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : undefined,
    stdin: opts.stdin !== undefined ? new Blob([opts.stdin as any]) : "ignore",
    stdout: opts.stream ? streamTarget : "pipe",
    stderr: opts.stream ? "inherit" : "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    opts.stream ? "" : new Response(proc.stdout as ReadableStream).text(),
    opts.stream ? "" : new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Unprivileged executor: operates directly as the current user. */
export class UserExecutor implements Executor {
  readonly privileged: boolean = process.getuid?.() === 0;

  run(argv: string[], opts?: RunOptions) {
    return spawn(argv, opts);
  }

  async readFile(path: string) {
    try {
      return new Uint8Array(await fs.readFile(path));
    } catch (e) {
      if (isErr(e, "ENOENT", "ENOTDIR", "EISDIR")) return null;
      throw e;
    }
  }

  async writeFile(path: string, data: Uint8Array, mode: number) {
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.rig-tmp-${process.pid}`;
    await fs.writeFile(tmp, data, { mode });
    await fs.chmod(tmp, mode); // umask-independent
    await fs.rename(tmp, path);
  }

  chmod(path: string, mode: number) {
    return fs.chmod(path, mode);
  }

  async lstat(path: string): Promise<Stat | null> {
    try {
      const s = await fs.lstat(path);
      return { type: typeOf(s), mode: s.mode & 0o7777 };
    } catch (e) {
      if (isErr(e, "ENOENT", "ENOTDIR")) return null;
      throw e;
    }
  }

  async readlink(path: string) {
    try {
      return await fs.readlink(path);
    } catch (e) {
      if (isErr(e, "ENOENT", "ENOTDIR", "EINVAL")) return null;
      throw e;
    }
  }

  async symlink(target: string, path: string) {
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.rig-tmp-${process.pid}`;
    await fs.rm(tmp, { force: true });
    await fs.symlink(target, tmp);
    await fs.rename(tmp, path);
  }

  async mkdirp(path: string, mode?: number) {
    await fs.mkdir(path, { recursive: true, mode });
    if (mode !== undefined) await fs.chmod(path, mode);
  }

  rename(from: string, to: string) {
    return fs.rename(from, to);
  }

  async unlink(path: string) {
    try {
      await fs.unlink(path);
    } catch (e) {
      if (!isErr(e, "ENOENT")) throw e;
    }
  }

  async rmdir(path: string) {
    try {
      await fs.rmdir(path);
      return true;
    } catch (e) {
      if (isErr(e, "ENOENT")) return true;
      if (isErr(e, "ENOTEMPTY", "EEXIST")) return false;
      throw e;
    }
  }
}

/** Prompt for the sudo password once, up front, so later calls don't interleave with output. */
export async function ensureSudo(): Promise<boolean> {
  if (process.getuid?.() === 0) return true;
  const proc = Bun.spawn(["sudo", "-v"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return (await proc.exited) === 0;
}
