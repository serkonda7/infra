// pacman repositories: one [section] of pacman.conf per resource, plus the
// signing keys it needs.

import type { ResourceBase, ResourceType, Result } from "../types.ts";
import { unifiedDiff } from "../plan/textdiff.ts";
import { errMsg } from "./util.ts";
import { pacman } from "./pacman.ts";

export interface RepoSpec extends ResourceBase {
  name: string;
  /** pacman.conf path. */
  conf: string;
  /** Section body, one `Key = value` per line. */
  body: string[];
  /** Where a new section goes: before all other repos (highest priority) or at the end. */
  position: "first" | "last";
  /** Key IDs to receive and locally sign. */
  keys: string[];
  keyserver?: string;
}

export interface RepoLive {
  /** Section body (meaningful lines only), null if the section is missing. */
  body: string[] | null;
}

export interface RepoMeta {
  conf: string;
  /** Section body before rig changed it; restored on destroy. */
  original?: string[];
  /** Keys rig imported. */
  keys: string[];
}

const dec = new TextDecoder();
const enc = new TextEncoder();
const header = (l: string) => l.match(/^\s*\[([^\]]+)\]\s*$/)?.[1];
const meaningful = (l: string) => l.trim() !== "" && !l.trim().startsWith("#");

/** Line range of a section: header index and end (exclusive, before trailing blanks/comments). */
function find(lines: string[], name: string): { start: number; end: number } | null {
  const start = lines.findIndex((l) => header(l) === name);
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && header(lines[end]!) === undefined) end++;
  while (end > start + 1 && !meaningful(lines[end - 1]!)) end--;
  return { start, end };
}

export function sectionBody(text: string, name: string): string[] | null {
  const lines = text.split("\n");
  const r = find(lines, name);
  return r ? lines.slice(r.start + 1, r.end).filter(meaningful).map((l) => l.trim()) : null;
}

export function setSection(text: string, name: string, body: string[], position: "first" | "last"): string {
  const lines = text.split("\n");
  const r = find(lines, name);
  if (r) {
    lines.splice(r.start + 1, r.end - r.start - 1, ...body);
    return lines.join("\n");
  }
  const block = [`[${name}]`, ...body, ""];
  if (position === "first") {
    const first = lines.findIndex((l) => header(l) !== undefined && header(l) !== "options");
    if (first >= 0) {
      lines.splice(first, 0, ...block);
      return lines.join("\n");
    }
  }
  while (lines.length && lines.at(-1) === "") lines.pop();
  return [...lines, "", ...block].join("\n");
}

export function removeSection(text: string, name: string): string {
  const lines = text.split("\n");
  const r = find(lines, name);
  if (!r) return text;
  let end = r.end;
  while (end < lines.length && lines[end]!.trim() === "") end++;
  lines.splice(r.start, end - r.start);
  return lines.join("\n");
}

const sameBody = (a: string[] | null | undefined, b: string[]) => !!a && a.length === b.length && a.every((l, i) => l === b[i]);

export const repoType: ResourceType<RepoSpec, RepoLive, RepoMeta> = {
  kind: "repo:pacman",
  label: "repositories",
  order: -10,
  scope: () => "system",
  id: (s) => `repo:pacman:${s.name}`,
  display: (id) => `[${id.slice("repo:pacman:".length)}]`,
  equal: (a, b) => a.conf === b.conf && sameBody(a.body, b.body) && a.position === b.position && String(a.keys) === String(b.keys),

  async read(items, x) {
    const out = new Map<string, RepoLive | null>();
    for (const { id, spec, meta } of items) {
      const conf = spec?.conf ?? meta?.conf ?? "/etc/pacman.conf";
      const data = await x.system.readFile(conf);
      out.set(id, data ? { body: sectionBody(dec.decode(data), id.slice("repo:pacman:".length)) } : null);
    }
    return out;
  },

  diff(spec, live, prev) {
    if (!live) return { op: "blocked", reason: `${spec.conf} does not exist` };
    const newKeys = spec.keys.filter((k) => !prev?.keys.includes(k));
    const bodyOk = sameBody(live.body, spec.body);
    if (bodyOk && !newKeys.length) return { op: "noop", meta: prev ?? { conf: spec.conf, keys: [] } };
    const notes = [];
    if (newKeys.length) notes.push(`import key${newKeys.length > 1 ? "s" : ""} ${newKeys.join(", ")}`);
    if (!bodyOk) notes.push("pacman -Sy");
    return {
      op: "change",
      action: live.body ? "update" : "create",
      note: notes.join(", "),
      detail: bodyOk ? undefined : unifiedDiff(live.body ? live.body.join("\n") + "\n" : "", spec.body.join("\n") + "\n") ?? undefined,
    };
  },

  async apply(changes, x, ctx) {
    const results: Result<RepoMeta>[] = [];
    let sync = false;
    for (const c of changes) {
      const { spec, live, prevMeta } = c;
      try {
        if (!sameBody(live?.body, spec.body)) {
          const data = await x.system.readFile(spec.conf);
          if (!data) throw new Error(`${spec.conf} does not exist`);
          const st = await x.system.lstat(spec.conf);
          await x.system.writeFile(spec.conf, enc.encode(setSection(dec.decode(data), spec.name, spec.body, spec.position)), st?.mode ?? 0o644);
          sync = true;
        }
        const keys = [...(prevMeta?.keys ?? [])];
        for (const k of spec.keys.filter((k) => !keys.includes(k))) {
          const recv = await x.system.run(["pacman-key", "--recv-keys", k, ...(spec.keyserver ? ["--keyserver", spec.keyserver] : [])], { stream: ctx.verbose });
          if (recv.code !== 0) throw new Error(`pacman-key --recv-keys ${k} failed: ${recv.stderr.trim()}`);
          const sign = await x.system.run(["pacman-key", "--lsign-key", k], { stream: ctx.verbose });
          if (sign.code !== 0) throw new Error(`pacman-key --lsign-key ${k} failed: ${sign.stderr.trim()}`);
          keys.push(k);
        }
        const original = prevMeta ? prevMeta.original : live?.body ?? undefined;
        results.push({ id: c.id, ok: true, meta: { conf: spec.conf, keys, ...(original ? { original } : {}) } });
      } catch (e) {
        results.push({ id: c.id, ok: false, error: errMsg(e) });
      }
    }
    if (sync) {
      // Fetch the new databases now; package installs later in this run upgrade in the same transaction (-Su).
      const r = await pacman(x.system, ["-Sy"], ctx.verbose);
      if (r.code !== 0) for (const res of results) if (res.ok) Object.assign(res, { note: `pacman -Sy failed: ${r.stderr.trim()}` });
    }
    return results;
  },

  planDestroy(_id, meta, live) {
    if (!live?.body) return { op: "forget", note: "section already gone" };
    return { op: "destroy", note: meta.original ? "restore original section" : "remove section" };
  },

  async destroy(items, x) {
    const results: Result<null>[] = [];
    for (const { id, meta } of items) {
      const name = id.slice("repo:pacman:".length);
      try {
        const data = await x.system.readFile(meta.conf);
        if (data) {
          const text = dec.decode(data);
          const next = meta.original ? setSection(text, name, meta.original, "last") : removeSection(text, name);
          if (next !== text) await x.system.writeFile(meta.conf, enc.encode(next), (await x.system.lstat(meta.conf))?.mode ?? 0o644);
        }
        results.push({ id, ok: true, meta: null });
      } catch (e) {
        results.push({ id, ok: false, error: errMsg(e) });
      }
    }
    return results;
  },
};
