import * as fs from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { isUnder, lines, targetPath, tilde } from "../resources/util.ts";
import type { Executors } from "../types.ts";

export interface AdoptPlan {
  path: string;
  dest: string;
  snippet: string;
  moduleFile?: string;
  newSource?: string;
}

/** Work out where an adopted file goes and how the module changes, without touching anything. */
export async function planAdopt(input: { path: string; repo: string; home: string; as?: string; module?: string }): Promise<AdoptPlan> {
  const { repo, home } = input;
  const path = targetPath(input.path, home);
  if (!isUnder(path, home) || path === home) throw new Error(`only paths inside your home can be adopted: ${path}`);
  if (isUnder(path, repo)) throw new Error(`${path} is already inside the repo`);
  const st = await fs.lstat(path).catch(() => null);
  if (!st) throw new Error(`${tilde(path, home)} does not exist`);
  if (st.isSymbolicLink()) throw new Error(`${tilde(path, home)} is already a symlink (→ ${await fs.readlink(path)})`);

  const rel = input.as ?? join("dotfiles", basename(path).replace(/^\./, ""));
  const dest = join(repo, rel);
  if (await fs.lstat(dest).catch(() => null)) throw new Error(`${relative(repo, dest)} already exists in the repo; pick another name with --as`);

  const repoRel = relative(repo, dest);
  const snippet = `link(${JSON.stringify(tilde(path, home))}, ${JSON.stringify(repoRel)});`;
  if (!input.module) return { path, dest, snippet };

  const moduleFile = await findModuleFile(repo, input.module);
  if (!moduleFile) throw new Error(`no module("${input.module}", …) found under ${repo}`);
  const source = await Bun.file(moduleFile).text();
  const newSource = insertLink(source, input.module, tilde(path, home), repoRel);
  if (!newSource) throw new Error(`could not find the body of module "${input.module}" in ${relative(repo, moduleFile)}; add this line yourself:\n  ${snippet}`);
  return { path, dest, snippet, moduleFile, newSource };
}

export async function executeAdopt(p: AdoptPlan) {
  await fs.mkdir(join(p.dest, ".."), { recursive: true });
  try {
    await fs.rename(p.path, p.dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    await fs.cp(p.path, p.dest, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
    await fs.rm(p.path, { recursive: true });
  }
  await fs.symlink(p.dest, p.path);
  if (p.moduleFile && p.newSource) await Bun.write(p.moduleFile, p.newSource);
}

async function findModuleFile(repo: string, name: string): Promise<string | null> {
  const needle = new RegExp(`\\bmodule\\(\\s*["'\`]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`);
  for await (const f of new Bun.Glob("**/*.ts").scan({ cwd: repo, onlyFiles: true })) {
    if (f.startsWith("node_modules/") || f.startsWith(".rig/")) continue;
    const path = join(repo, f);
    if (needle.test(await Bun.file(path).text())) return path;
  }
  return null;
}

/**
 * Insert `link(...)` as the last statement of `module("name", (ctx) => { ... })`.
 * A small scanner skips strings, template literals and comments while matching braces.
 */
export function insertLink(src: string, name: string, path: string, repoRel: string): string | null {
  const m = new RegExp(`\\bmodule\\(\\s*["'\`]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]\\s*,`).exec(src);
  if (!m) return null;
  const arrow = src.indexOf("=>", m.index);
  if (arrow < 0) return null;
  const params = src.slice(m.index + m[0].length, arrow);
  let open = arrow + 2;
  while (/\s/.test(src[open] ?? "")) open++;
  if (src[open] !== "{") return null;
  const close = matchBrace(src, open);
  if (close < 0) return null;

  // How is the context named? `(ctx, …)` → ctx.link; `({ pkg, … })` → link (added to the pattern if missing).
  const ident = params.match(/^\s*\(?\s*([A-Za-z_$][\w$]*)/)?.[1];
  const destructured = /^\s*\(\s*\{/.test(params);
  let call = "link";
  let paramsOut = params;
  if (destructured) {
    const pattern = params.slice(params.indexOf("{"), params.indexOf("}") + 1);
    if (!/\blink\b/.test(pattern)) paramsOut = params.replace(/\{\s*/, "{ link, ");
  } else if (ident) call = `${ident}.link`;
  else return null;

  const lineStart = src.lastIndexOf("\n", close - 1) + 1;
  const closeIndent = src.slice(lineStart, close).match(/^\s*/)![0];
  const stmt = `${closeIndent}  ${call}(${JSON.stringify(path)}, ${JSON.stringify(repoRel)});\n`;
  const head = src.slice(0, close).replace(/[ \t]*$/, "");
  let out = (head.endsWith("\n") ? head : head + "\n") + stmt + closeIndent + src.slice(close);
  // The params sit before the insertion point, so their offsets are unchanged.
  const pStart = m.index + m[0].length;
  if (paramsOut !== params) out = out.slice(0, pStart) + paramsOut + out.slice(pStart + params.length);
  return out;
}

function matchBrace(src: string, open: number): number {
  // Stack of contexts: "{" code block, "`" template, "${" template expression.
  const stack: string[] = [];
  for (let i = open; i < src.length; i++) {
    const ch = src[i]!;
    const top = stack.at(-1);
    if (top === "`") {
      if (ch === "\\") i++;
      else if (ch === "`") stack.pop();
      else if (ch === "$" && src[i + 1] === "{") stack.push("${"), i++;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i < 0) return -1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      if (i <= 0) return -1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === "\\") i++;
      continue;
    }
    if (ch === "`") stack.push("`");
    else if (ch === "{") stack.push("{");
    else if (ch === "}") {
      const t = stack.pop();
      if (t === "{" && stack.length === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// rig adopt packages

export interface PackageAdoption {
  explicit: number;
  declared: number;
  kept: number;
  repo: string[];
  aur: string[];
  file: string;
  source: string;
}

/** Explicitly installed packages the host's config doesn't declare yet, as a module to sort out. */
export async function planAdoptPackages(input: {
  repo: string;
  host: string;
  declared: ReadonlySet<string>;
  keep: string[];
  x: Executors;
  date?: string;
}): Promise<PackageAdoption> {
  const [explicitOut, foreignOut] = await Promise.all([input.x.user.run(["pacman", "-Qqe"]), input.x.user.run(["pacman", "-Qqm"])]);
  if (explicitOut.code !== 0) throw new Error(`pacman -Qqe failed: ${explicitOut.stderr.trim()}`);
  const explicit = lines(explicitOut.stdout);
  const foreign = new Set(lines(foreignOut.stdout));
  const kept = input.keep.map((k) => new Bun.Glob(k));
  let declared = 0, keptN = 0;
  const repo: string[] = [], aur: string[] = [];
  for (const n of explicit) {
    if (input.declared.has(`pkg:pacman:${n}`) || input.declared.has(`pkg:aur:${n}`)) declared++;
    else if (kept.some((g) => g.match(n))) keptN++;
    else (foreign.has(n) ? aur : repo).push(n);
  }
  const list = (xs: string[]) => xs.map((n) => `    ${JSON.stringify(n)},`).join("\n");
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const source = [
    `import { module } from "rig";`,
    ``,
    `// Adopted from ${input.host} by \`rig adopt packages\` on ${date}.`,
    `// Sort these into modules, then switch the host to packages: { mode: "exact" }.`,
    `export const adoptedPackages = module("adopted-packages", (ctx) => {`,
    ...(repo.length ? [`  ctx.pkg([`, list(repo), `  ]);`] : []),
    ...(aur.length ? [`  ctx.pkg.aur([`, list(aur), `  ]);`] : []),
    `});`,
    ``,
  ].join("\n");
  return { explicit: explicit.length, declared, kept: keptN, repo, aur, file: join(input.repo, "modules/_adopted", `${input.host}-packages.ts`), source };
}
