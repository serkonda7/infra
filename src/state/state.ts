import * as fs from "node:fs/promises";
import { openSync, closeSync, writeSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ObjectStore, Scope } from "../types.ts";

export interface GenEntry {
  kind: string;
  scope: Scope;
  meta: unknown;
  /** Rendered name, so destroys can be displayed without the original spec. */
  display: string;
}

export interface Generation {
  id: number;
  at: string;
  host: string;
  commit: string | null;
  status: "ok" | "partial";
  /** System snapshot taken before this apply, e.g. "snapper:#318". */
  snapshot?: string;
  /** Applied by `rig rollback <n>`: the config of generation n. */
  rollbackOf?: number;
  resources: Record<string, GenEntry>;
}

/** Object-store references anywhere in resource metas (any resource type, plugins included, may hold backups). */
function collectObjectRefs(v: unknown, into: Set<string>) {
  if (typeof v === "string") {
    if (/^sha256:[0-9a-f]{64}$/.test(v)) into.add(v);
  } else if (v && typeof v === "object") for (const x of Object.values(v)) collectObjectRefs(x, into);
}

export function defaultStateDir(home: string) {
  return join(process.env.XDG_STATE_HOME || join(home, ".local/state"), "rig");
}

export class StateStore {
  constructor(readonly dir: string) {}

  private genDir(host: string) {
    return join(this.dir, "hosts", host, "generations");
  }

  async list(host: string): Promise<number[]> {
    try {
      return (await fs.readdir(this.genDir(host)))
        .map((f) => f.match(/^(\d+)\.json$/)?.[1])
        .filter((n): n is string => !!n)
        .map(Number)
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }

  async load(host: string, id: number): Promise<Generation> {
    return JSON.parse(await fs.readFile(join(this.genDir(host), `${id}.json`), "utf8"));
  }

  async latest(host: string): Promise<Generation | null> {
    const ids = await this.list(host);
    return ids.length ? this.load(host, ids.at(-1)!) : null;
  }

  async write(gen: Generation) {
    const dir = this.genDir(gen.host);
    await fs.mkdir(dir, { recursive: true });
    const path = join(dir, `${gen.id}.json`);
    await fs.writeFile(path + ".tmp", JSON.stringify(gen, null, 2) + "\n");
    await fs.rename(path + ".tmp", path);
  }

  async hosts(): Promise<string[]> {
    try {
      return (await fs.readdir(join(this.dir, "hosts"))).sort();
    } catch {
      return [];
    }
  }

  /**
   * Delete all but the newest `keep` generations of every host, then the backup objects no
   * remaining generation refers to. The newest generation is always kept: it is what pruning
   * compares against.
   */
  async gc(keep: number): Promise<{ generations: { host: string; id: number }[]; objects: number }> {
    keep = Math.max(1, keep);
    const removed: { host: string; id: number }[] = [];
    const referenced = new Set<string>();
    for (const host of await this.hosts()) {
      const ids = await this.list(host);
      for (const id of ids.slice(0, -keep)) {
        await fs.rm(join(this.genDir(host), `${id}.json`));
        removed.push({ host, id });
      }
      for (const id of ids.slice(-keep)) collectObjectRefs((await this.load(host, id)).resources, referenced);
    }
    let objects = 0;
    const dir = join(this.dir, "objects");
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      if (referenced.has(`sha256:${name}`)) continue;
      await fs.rm(join(dir, name));
      objects++;
    }
    return { generations: removed, objects };
  }

  objects(): ObjectStore {
    const dir = join(this.dir, "objects");
    return {
      async put(data) {
        const hash = new Bun.CryptoHasher("sha256").update(data).digest("hex");
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const path = join(dir, hash);
        // Backups can contain anything (e.g. /etc files): keep them private.
        await fs.writeFile(path, data, { mode: 0o600, flag: "w" });
        return `sha256:${hash}`;
      },
      async get(ref) {
        try {
          return new Uint8Array(await fs.readFile(join(dir, ref.replace(/^sha256:/, ""))));
        } catch {
          return null;
        }
      },
    };
  }

  /** Exclusive run lock; stale locks from dead processes are taken over. */
  lock(): () => void {
    const path = join(this.dir, "lock");
    mkdirSync(this.dir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, "wx");
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return () => {
          try {
            unlinkSync(path);
          } catch {}
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const pid = Number(readFileSync(path, "utf8"));
        let alive = false;
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {}
        if (alive) throw new Error(`another rig run is in progress (pid ${pid})`);
        unlinkSync(path);
      }
    }
    throw new Error("could not acquire lock");
  }
}
