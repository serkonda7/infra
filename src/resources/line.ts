// Edits to files rig doesn't own as a whole: a single line (optionally
// replacing a regex match) or a marker-delimited block.

import type { Executor, ResourceBase, ResourceType, Result, Scope, StatType } from "../types.ts";
import { pick } from "../types.ts";
import { unifiedDiff } from "../plan/textdiff.ts";
import { errMsg, tilde } from "./util.ts";

export interface LineSpec extends ResourceBase {
  path: string;
  key: string;
  /** The line, or the block body. */
  text: string;
  block: boolean;
  /** Regex source: replace the first matching line instead of appending (line mode). */
  match?: string;
  /** Comment prefix for block markers. */
  comment: string;
  scope: Scope;
}

export interface LineLive {
  type: StatType;
  mode: number;
  content: string;
}

export interface LineMeta {
  text: string;
  block: boolean;
  key: string;
  comment: string;
  /** The line our line replaced; put back on destroy. */
  original?: string;
  /** The exact line was already there before rig: left in place on destroy. */
  preexisting?: boolean;
}

const dec = new TextDecoder();
const enc = new TextEncoder();
// Keys may contain "#" (they default to the line itself); paths practically never do.
const pathOf = (id: string) => id.slice("line:".length, id.indexOf("#"));
const markers = (key: string, comment: string) => [`${comment} BEGIN rig ${key}`, `${comment} END rig ${key}`] as const;

const split = (s: string) => {
  const l = s.split("\n");
  if (l.at(-1) === "") l.pop();
  return l;
};
const join = (l: string[]) => (l.length ? l.join("\n") + "\n" : "");

/** Apply one edit to file content. `prevText` is what rig wrote last time (to replace it when the line changed). */
export function edit(content: string, spec: Pick<LineSpec, "text" | "block" | "match" | "key" | "comment">, prevText?: string): { content: string; original?: string } {
  const l = split(content);
  if (spec.block) {
    const [begin, end] = markers(spec.key, spec.comment);
    const body = split(spec.text);
    const b = l.indexOf(begin);
    const e = b >= 0 ? l.indexOf(end, b) : -1;
    if (b >= 0 && e >= 0) l.splice(b, e - b + 1, begin, ...body, end);
    else l.push(begin, ...body, end);
    return { content: join(l) };
  }
  if (l.includes(spec.text)) return { content };
  if (prevText !== undefined && prevText !== spec.text) {
    const i = l.indexOf(prevText);
    if (i >= 0) {
      l[i] = spec.text;
      return { content: join(l) };
    }
  }
  if (spec.match) {
    const re = new RegExp(spec.match);
    const i = l.findIndex((x) => re.test(x));
    if (i >= 0) {
      const original = l[i];
      l[i] = spec.text;
      return { content: join(l), original };
    }
  }
  l.push(spec.text);
  return { content: join(l) };
}

/** Undo an edit described by its meta. */
export function unedit(content: string, meta: LineMeta): string {
  const l = split(content);
  if (meta.block) {
    const [begin, end] = markers(meta.key, meta.comment);
    const b = l.indexOf(begin);
    const e = b >= 0 ? l.indexOf(end, b) : -1;
    if (b >= 0 && e >= 0) l.splice(b, e - b + 1);
    return join(l);
  }
  const i = l.indexOf(meta.text);
  if (i < 0) return content;
  if (meta.original !== undefined) l[i] = meta.original;
  else l.splice(i, 1);
  return join(l);
}

async function rewrite(ex: Executor, path: string, fn: (content: string) => string) {
  const st = await ex.lstat(path);
  const data = st ? await ex.readFile(path) : null;
  const before = data ? dec.decode(data) : "";
  const after = fn(before);
  if (after !== before || !st) await ex.writeFile(path, enc.encode(after), st?.mode ?? 0o644);
}

export const lineType: ResourceType<LineSpec, LineLive, LineMeta> = {
  kind: "line",
  label: "file edits",
  order: 25,
  scope: (s) => s.scope,
  id: (s) => `line:${s.path}#${s.key}`,
  display: (id, _s, { home }) => `${tilde(pathOf(id), home)} #${id.slice(id.indexOf("#") + 1)}`,
  equal: (a, b) => a.text === b.text && a.block === b.block && a.match === b.match && a.comment === b.comment,

  async read(items, x) {
    const out = new Map<string, LineLive | null>();
    await Promise.all(
      items.map(async ({ id, scope }) => {
        const ex = pick(x, scope);
        const path = pathOf(id);
        const st = await ex.lstat(path);
        if (!st) return out.set(id, null);
        if (st.type !== "file") return out.set(id, { type: st.type, mode: st.mode, content: "" });
        out.set(id, { type: "file", mode: st.mode, content: dec.decode((await ex.readFile(path)) ?? new Uint8Array()) });
      }),
    );
    return out;
  },

  diff(spec, live, prev) {
    const meta = (original?: string, preexisting?: boolean): LineMeta => ({
      text: spec.text,
      block: spec.block,
      key: spec.key,
      comment: spec.comment,
      ...(original !== undefined ? { original } : {}),
      ...(preexisting ? { preexisting } : {}),
    });
    if (!live) return { op: "change", action: "create", note: "creates the file" };
    if (live.type !== "file") return { op: "blocked", reason: `a ${live.type} exists at this path` };
    const next = edit(live.content, spec, prev?.text);
    if (next.content === live.content) {
      // An identical line that was there before rig took over is not ours to remove.
      return { op: "noop", meta: prev ? { ...meta(prev.original), preexisting: prev.preexisting } : meta(undefined, !spec.block) };
    }
    return { op: "change", action: "update", detail: unifiedDiff(live.content, next.content) ?? undefined };
  },

  async apply(changes, x) {
    const results: Result<LineMeta>[] = [];
    // All edits to one file are applied to the fresh content and written once.
    const byPath = new Map<string, typeof changes>();
    for (const c of changes) (byPath.get(c.spec.path) ?? byPath.set(c.spec.path, []).get(c.spec.path)!).push(c);
    for (const [path, list] of byPath) {
      const metas = new Map<string, LineMeta>();
      try {
        await rewrite(pick(x, list[0]!.spec.scope), path, (content) => {
          for (const c of list) {
            const r = edit(content, c.spec, c.prevMeta?.text);
            content = r.content;
            const original = c.prevMeta?.original ?? r.original;
            metas.set(c.id, { text: c.spec.text, block: c.spec.block, key: c.spec.key, comment: c.spec.comment, ...(original !== undefined ? { original } : {}) });
          }
          return content;
        });
        for (const c of list) results.push({ id: c.id, ok: true, meta: metas.get(c.id)! });
      } catch (e) {
        for (const c of list) results.push({ id: c.id, ok: false, error: errMsg(e) });
      }
    }
    return results;
  },

  planDestroy(_id, meta, live) {
    if (!live || live.type !== "file") return { op: "forget", note: "file is gone" };
    if (meta.preexisting) return { op: "forget", note: "line was there before rig; kept" };
    if (unedit(live.content, meta) === live.content) return { op: "forget", note: "already removed" };
    return { op: "destroy", note: meta.original !== undefined ? "restore original line" : meta.block ? "remove block" : "remove line" };
  },

  async destroy(items, x) {
    const results: Result<null>[] = [];
    const byPath = new Map<string, typeof items>();
    for (const i of items) (byPath.get(pathOf(i.id)) ?? byPath.set(pathOf(i.id), []).get(pathOf(i.id))!).push(i);
    for (const [path, list] of byPath) {
      try {
        await rewrite(pick(x, list[0]!.scope), path, (content) => list.reduce((c, i) => unedit(c, i.meta), content));
        for (const i of list) results.push({ id: i.id, ok: true, meta: null });
      } catch (e) {
        for (const i of list) results.push({ id: i.id, ok: false, error: errMsg(e) });
      }
    }
    return results;
  },
};
