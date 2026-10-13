import type { ResourceBase, ResourceType, Scope, StatType } from "../types.ts";
import { pick } from "../types.ts";
import { unifiedDiff, looksBinary } from "../plan/textdiff.ts";
import { errMsg, idPath, octal, tilde, xxh } from "./util.ts";

export interface FileSpec extends ResourceBase {
  path: string;
  data: Uint8Array;
  hash: string;
  /** Permission bits; unmanaged (keeps existing, 0644 on create) when omitted. */
  mode?: number;
  scope: Scope;
  /** Content comes from a secret: never shown in plan output. */
  secret?: boolean;
}

export interface FileLive {
  type: StatType;
  mode: number;
  data?: Uint8Array;
  hash?: string;
}

export interface FileMeta {
  /** Hash of what rig last wrote — used to detect edits before pruning. */
  hash: string;
  /** Object-store hash of content that existed before rig took over. */
  backup?: string;
  /** The file already had exactly the desired content: leave it on destroy. */
  preexisting?: boolean;
}

const dec = new TextDecoder();

export function contentDiff(before: Uint8Array | undefined, after: Uint8Array): string | undefined {
  if (!before) return undefined;
  if (looksBinary(before) || looksBinary(after)) return "(binary content changed)";
  return unifiedDiff(dec.decode(before), dec.decode(after)) ?? "(large file changed)";
}

export const fileType: ResourceType<FileSpec, FileLive, FileMeta> = {
  kind: "file",
  label: "files",
  order: 20,
  scope: (s) => s.scope,
  id: (s) => `file:${s.path}`,
  display: (id, _s, { home }) => tilde(idPath(id), home),
  equal: (a, b) => a.hash === b.hash && a.mode === b.mode,

  async read(items, x) {
    const out = new Map<string, FileLive | null>();
    await Promise.all(
      items.map(async ({ id, scope }) => {
        const ex = pick(x, scope);
        const path = idPath(id);
        const st = await ex.lstat(path);
        if (!st) return out.set(id, null);
        if (st.type !== "file") return out.set(id, { type: st.type, mode: st.mode });
        const data = (await ex.readFile(path)) ?? new Uint8Array();
        out.set(id, { type: "file", mode: st.mode, data, hash: xxh(data) });
      }),
    );
    return out;
  },

  diff(spec, live, prev, ctx) {
    if (!live) return { op: "change", action: "create" };
    if (live.type === "dir") return { op: "blocked", reason: "a directory exists at this path" };
    if (live.type !== "file") {
      if (!ctx.force) return { op: "blocked", reason: `a ${live.type} exists at this path (use --force to replace it)` };
      return { op: "change", action: "update", note: `replaces ${live.type}` };
    }
    const modeDiff = spec.mode !== undefined && spec.mode !== live.mode;
    if (live.hash === spec.hash && !modeDiff) {
      return { op: "noop", meta: prev ? { ...prev, hash: spec.hash } : { hash: spec.hash, preexisting: true } };
    }
    const notes: string[] = [];
    if (spec.secret && live.hash !== spec.hash) notes.push("content changed, secret");
    if (modeDiff) notes.push(`mode ${octal(live.mode)} → ${octal(spec.mode!)}`);
    if (prev && live.hash !== prev.hash) notes.push("modified outside rig");
    if (!prev && live.hash !== spec.hash) notes.push("original will be backed up");
    return {
      op: "change",
      action: "update",
      note: notes.join(", ") || undefined,
      detail: live.hash !== spec.hash && !spec.secret ? contentDiff(live.data, spec.data) : undefined,
    };
  },

  async apply(changes, x, ctx) {
    return Promise.all(
      changes.map(async (c) => {
        try {
          const { spec, live, prevMeta } = c;
          let backup = prevMeta?.backup;
          // First time we take over an existing file: keep the original so destroy can restore it.
          if (!prevMeta && live?.type === "file" && live.data) backup = await ctx.objects.put(live.data);
          const ex = pick(x, spec.scope);
          if (live?.type === "file" && live.hash === spec.hash) {
            await ex.chmod(spec.path, spec.mode!);
          } else {
            if (live && live.type !== "file") await ex.unlink(spec.path);
            await ex.writeFile(spec.path, spec.data, spec.mode ?? (live?.type === "file" ? live.mode : 0o644));
          }
          return { id: c.id, ok: true as const, meta: { hash: spec.hash, ...(backup ? { backup } : {}) } };
        } catch (e) {
          return { id: c.id, ok: false as const, error: errMsg(e) };
        }
      }),
    );
  },

  planDestroy(_id, meta, live, ctx) {
    if (!live) return { op: "forget", note: "already gone" };
    if (live.type !== "file") return { op: "forget", note: `now a ${live.type}; leaving it` };
    if (live.hash !== meta.hash && !ctx.force)
      return { op: "blocked", reason: "modified since rig wrote it; remove it yourself or use --force" };
    if (meta.preexisting) return { op: "forget", note: "existed before rig; kept" };
    if (meta.backup) return { op: "destroy", note: "restore original" };
    return { op: "destroy" };
  },

  async destroy(items, x, ctx) {
    const results = [];
    for (const { id, scope, meta } of items) {
      const ex = pick(x, scope);
      const path = idPath(id);
      try {
        if (meta.backup) {
          const data = await ctx.objects.get(meta.backup);
          if (!data) throw new Error(`backup object ${meta.backup} missing`);
          const st = await ex.lstat(path);
          await ex.writeFile(path, data, st?.mode ?? 0o644);
        } else {
          await ex.unlink(path);
        }
        results.push({ id, ok: true as const, meta: null });
      } catch (e) {
        results.push({ id, ok: false as const, error: errMsg(e) });
      }
    }
    return results;
  },
};
