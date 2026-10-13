// What a remote host gets instead of the repo: the config bundled into one
// module, a tarball of exactly the repo files evaluation reads, and the
// secrets it uses, decrypted locally.

import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { ConfigError, decryptSecrets, evaluateHost, type Target } from "../engine.ts";
import { CONFIG_FILE } from "../config/load.ts";
import { isUnder } from "../resources/util.ts";
import type { Facts } from "../types.ts";
import type { Bundle } from "./protocol.ts";

/** The bundled config inside the unpacked bundle directory. */
export const BUNDLE_FILE = ".rig-bundle.js";

const b64 = (d: Uint8Array) => Buffer.from(d).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** Repo-relative paths, without entries already covered by an included directory. */
export function assetPaths(repo: string, assets: Iterable<string>): string[] {
  const rel = [...new Set([...assets].filter((p) => p !== repo && isUnder(p, repo)).map((p) => relative(repo, p)))].sort();
  return rel.filter((p) => !rel.some((q) => q !== p && isUnder(p, q)));
}

async function tar(argv: string[], stdin: Uint8Array): Promise<Uint8Array> {
  const proc = Bun.spawn(["tar", ...argv], { stdin: new Blob([stdin as any]), stdout: "pipe", stderr: "pipe" });
  const [out, errText, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`tar ${argv[0]} failed: ${errText.trim()}`);
  return new Uint8Array(out);
}

/** Evaluate against the target's facts to learn what the bundle needs, then build it. */
export async function buildBundle(t: Target, facts: Facts, commit: string | null): Promise<Bundle> {
  const graph = evaluateHost(t, facts);
  graph.finalize();
  if (graph.errors.length) throw new ConfigError(graph.errors);
  const secrets = graph.secrets.size ? await decryptSecrets(t.repo, graph.secrets) : new Map<string, Uint8Array>();

  const built = await Bun.build({ entrypoints: [join(t.repo, CONFIG_FILE)], target: "bun", format: "esm", external: ["rig"], sourcemap: "inline" });
  if (!built.success) throw new Error(`bundling ${CONFIG_FILE} failed:\n${built.logs.map(String).join("\n")}`);

  const paths = assetPaths(t.repo, graph.assets);
  const enc = new TextEncoder();
  const assets = await tar(["-C", t.repo, "-czf", "-", "--null", "-T", "-"], enc.encode(paths.map((p) => p + "\0").join("")));
  return {
    version: 1,
    host: t.hostName,
    commit,
    config: rebaseSourceMap(await built.outputs[0]!.text(), t.repo),
    assets: b64(assets),
    secrets: Object.fromEntries([...secrets].map(([k, v]) => [k, b64(v)])),
  };
}

/**
 * Bun writes source-map paths relative to the working directory. Make them repo-relative: the bundle
 * sits at the root of the unpacked repo, so stack traces (and provenance) read "modules/x.ts:12".
 */
export function rebaseSourceMap(code: string, repo: string): string {
  const m = code.match(/\n\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)\s*$/);
  if (!m) return code;
  const map = JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8")) as { sources?: string[] };
  map.sources = map.sources?.map((src) => relative(repo, resolve(process.cwd(), src)));
  return code.slice(0, m.index) + `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`;
}

/**
 * Unpack into ~/.local/share/rig/bundles/<host> on the target. The path is stable because links
 * point into it; the directory is swapped as a whole so they never see a half-written tree.
 */
export async function unpackBundle(b: Bundle): Promise<{ dir: string; secrets: Map<string, Uint8Array> }> {
  if (b.version !== 1) throw new Error(`unsupported bundle version ${b.version}; update rig on both ends`);
  if (!/^[\w.-]+$/.test(b.host)) throw new Error(`invalid host name in bundle: ${b.host}`);
  const base = join(process.env.XDG_DATA_HOME || join(process.env.HOME || homedir(), ".local/share"), "rig/bundles");
  const dir = join(base, b.host);
  const tmp = `${dir}.new-${process.pid}`;
  const old = `${dir}.old-${process.pid}`;
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.mkdir(tmp, { recursive: true, mode: 0o700 });
  await tar(["-xzf", "-", "-C", tmp], unb64(b.assets));
  await Bun.write(join(tmp, BUNDLE_FILE), b.config);
  if (existsSync(dir)) await fs.rename(dir, old);
  await fs.rename(tmp, dir);
  await fs.rm(old, { recursive: true, force: true });
  return { dir, secrets: new Map(Object.entries(b.secrets).map(([k, v]) => [k, unb64(v)])) };
}
