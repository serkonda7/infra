// Privileged side of rig: `sudo rig __helper`. Speaks NDJSON over stdin/stdout
// and exposes exactly the Executor operations — it never loads or evaluates
// config, so the code running as root stays small and auditable.

import { UserExecutor, streamToStderr } from "../exec/local.ts";
import type { RunOptions } from "../types.ts";

export interface Request {
  id: number;
  op: string;
  args: unknown[];
}

export type Response = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string; code?: string };

export const b64 = (data: Uint8Array) => Buffer.from(data).toString("base64");
export const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

type Handler = (x: UserExecutor, args: any[]) => Promise<unknown>;

const OPS: Record<string, Handler> = {
  run: (x, [argv, opts]) => {
    const o = opts as (Omit<RunOptions, "stdin"> & { stdin?: string }) | undefined;
    return x.run(argv, o && { ...o, stdin: o.stdin !== undefined ? unb64(o.stdin) : undefined });
  },
  readFile: async (x, [path]) => {
    const data = await x.readFile(path);
    return data && b64(data);
  },
  writeFile: (x, [path, data, mode]) => x.writeFile(path, unb64(data), mode),
  chmod: (x, [path, mode]) => x.chmod(path, mode),
  lstat: (x, [path]) => x.lstat(path),
  readlink: (x, [path]) => x.readlink(path),
  symlink: (x, [target, path]) => x.symlink(target, path),
  // JSON turns an omitted mode into null.
  mkdirp: (x, [path, mode]) => x.mkdirp(path, mode ?? undefined),
  rename: (x, [from, to]) => x.rename(from, to),
  unlink: (x, [path]) => x.unlink(path),
  rmdir: (x, [path]) => x.rmdir(path),
};

export async function handle(x: UserExecutor, req: Request): Promise<Response> {
  const op = Object.hasOwn(OPS, req.op) ? OPS[req.op] : undefined;
  if (!op) return { id: req.id, ok: false, error: `unknown op: ${req.op}` };
  try {
    return { id: req.id, ok: true, value: (await op(x, req.args)) ?? null };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { id: req.id, ok: false, error: err?.message ?? String(e), code: err?.code };
  }
}

/** Serve requests until stdin closes. Requests are handled concurrently; responses carry the request id. */
export async function serveHelper(): Promise<void> {
  streamToStderr();
  process.umask(0o022);
  const x = new UserExecutor();
  const inflight = new Set<Promise<void>>();
  const decoder = new TextDecoder();
  let buf = "";
  const dispatch = (line: string) => {
    let req: Request;
    try {
      req = JSON.parse(line);
    } catch {
      process.stderr.write(`rig helper: bad request: ${line.slice(0, 200)}\n`);
      return;
    }
    const p = handle(x, req).then((res) => void process.stdout.write(JSON.stringify(res) + "\n"));
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  };
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) dispatch(line);
    }
  }
  await Promise.all(inflight);
}
