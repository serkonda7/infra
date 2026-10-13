import { isAbsolute, resolve, dirname } from "node:path";
import type { Scope } from "../types.ts";

export const xxh = (data: Uint8Array | string) => "xxh3:" + Bun.hash.xxHash3(data).toString(16).padStart(16, "0");

/** Expand `~` and require an absolute path for things placed on the machine. */
export function targetPath(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return resolve(home, p.slice(2));
  if (!isAbsolute(p)) throw new Error(`path must be absolute or start with ~/: ${p}`);
  return resolve(p);
}

/** Resolve a path inside the config repo (relative paths are repo-relative). */
export function repoPath(p: string, repo: string, home: string): string {
  if (p.startsWith("~")) return targetPath(p, home);
  return isAbsolute(p) ? resolve(p) : resolve(repo, p);
}

export const isUnder = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : dir + "/");

export const scopeOf = (path: string, home: string): Scope => (isUnder(path, home) ? "user" : "system");

export const tilde = (path: string, home: string) => (isUnder(path, home) ? "~" + path.slice(home.length) : path);

export function pretty(path: string, home: string, repo: string): string {
  if (isUnder(path, repo)) return path.slice(dirname(repo).length + 1);
  return tilde(path, home);
}

/** "file:/etc/x" → "/etc/x" */
export const idPath = (id: string) => id.slice(id.indexOf(":") + 1);

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const octal = (m: number) => "0" + m.toString(8).padStart(3, "0");

export const lines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
