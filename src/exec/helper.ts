import { join } from "node:path";
import type { Subprocess } from "bun";
import type { Executor, RunOptions, RunResult, Stat } from "../types.ts";
import { UserExecutor } from "./local.ts";
import { b64, unb64, type Response } from "../helper/server.ts";

const isErr = (e: unknown, ...codes: string[]) => codes.includes((e as NodeJS.ErrnoException)?.code ?? "");

/** How to start this very rig as the helper: the compiled binary, or bun + the CLI entry when run from source. */
export function selfCommand(): string[] {
  if (import.meta.path.startsWith("/$bunfs/")) return [process.execPath, "__helper"];
  return [process.execPath, join(import.meta.dir, "../cli/main.ts"), "__helper"];
}

/**
 * Root executor for system-scoped resources. Mutations are forwarded to one
 * `sudo rig __helper` process (started lazily, so plans that only read
 * world-readable state never prompt). Reads go direct and fall back to the
 * helper on EACCES.
 */
export class HelperExecutor implements Executor {
  readonly privileged = true;
  private direct = new UserExecutor();
  private proc: Subprocess<"pipe", "pipe", "inherit"> | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private dead: string | null = null;

  /** `command` is the full argv that starts a helper (default: sudo + this rig). */
  constructor(private command: string[] = ["sudo", "--", ...selfCommand()]) {}

  private start() {
    const proc = Bun.spawn(this.command, { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    this.proc = proc;
    (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stdout) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const res = JSON.parse(line) as Response;
          const p = this.pending.get(res.id);
          if (!p) continue;
          this.pending.delete(res.id);
          if (res.ok) p.resolve(res.value);
          else p.reject(Object.assign(new Error(res.error), res.code ? { code: res.code } : {}));
        }
      }
      const code = await proc.exited;
      this.dead = `privileged helper exited (code ${code})${code === 1 ? " — sudo authentication failed?" : ""}`;
      for (const p of this.pending.values()) p.reject(new Error(this.dead));
      this.pending.clear();
    })();
  }

  private call<T>(op: string, ...args: unknown[]): Promise<T> {
    if (this.dead) return Promise.reject(new Error(this.dead));
    if (!this.proc) this.start();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.proc!.stdin.write(JSON.stringify({ id, op, args }) + "\n");
      this.proc!.stdin.flush();
    });
  }

  async close() {
    if (!this.proc) return;
    this.proc.stdin.end();
    await this.proc.exited;
    this.proc = null;
  }

  run(argv: string[], opts?: RunOptions): Promise<RunResult> {
    const o = opts && { ...opts, stdin: opts.stdin === undefined ? undefined : b64(typeof opts.stdin === "string" ? new TextEncoder().encode(opts.stdin) : opts.stdin) };
    return this.call("run", argv, o);
  }

  async readFile(path: string) {
    try {
      return await this.direct.readFile(path);
    } catch (e) {
      if (!isErr(e, "EACCES")) throw e;
      const v = await this.call<string | null>("readFile", path);
      return v === null ? null : unb64(v);
    }
  }

  async lstat(path: string): Promise<Stat | null> {
    try {
      return await this.direct.lstat(path);
    } catch (e) {
      if (!isErr(e, "EACCES")) throw e;
      return this.call("lstat", path);
    }
  }

  async readlink(path: string) {
    try {
      return await this.direct.readlink(path);
    } catch (e) {
      if (!isErr(e, "EACCES")) throw e;
      return this.call<string | null>("readlink", path);
    }
  }

  writeFile(path: string, data: Uint8Array, mode: number) {
    return this.call<void>("writeFile", path, b64(data), mode);
  }
  chmod(path: string, mode: number) {
    return this.call<void>("chmod", path, mode);
  }
  symlink(target: string, path: string) {
    return this.call<void>("symlink", target, path);
  }
  mkdirp(path: string, mode?: number) {
    return this.call<void>("mkdirp", path, mode);
  }
  rename(from: string, to: string) {
    return this.call<void>("rename", from, to);
  }
  unlink(path: string) {
    return this.call<void>("unlink", path);
  }
  rmdir(path: string) {
    return this.call<boolean>("rmdir", path);
  }
}

/**
 * The system executor for this process: in-process when already root, otherwise the sudo helper.
 * `nonInteractive` (remote runs, no terminal) makes sudo fail instead of prompting; the password
 * was validated up front.
 */
export const systemExecutor = (nonInteractive = false): Executor =>
  process.getuid?.() === 0 ? new UserExecutor() : new HelperExecutor(["sudo", ...(nonInteractive ? ["-n"] : []), "--", ...selfCommand()]);
