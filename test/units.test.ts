import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readlinkSync, lstatSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unifiedDiff } from "../src/plan/textdiff.ts";
import { tmpl } from "../src/config/context.ts";
import { parseCpuInfo, parseOsRelease } from "../src/facts/index.ts";
import { executeAdopt, insertLink, planAdopt } from "../src/cli/adopt.ts";
import { loadConfig } from "../src/config/load.ts";

describe("unifiedDiff", () => {
  test("produces hunks with context", () => {
    const a = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
    const b = "1\n2\n3\n4\nfive\n6\n7\n8\n9\n10\n";
    expect(unifiedDiff(a, b)).toBe("@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8");
  });
  test("additions to empty", () => {
    expect(unifiedDiff("", "a\n")).toBe("@@ -1,0 +1,1 @@\n+a");
  });
});

test("tmpl strips leading newline and common indent", () => {
  const name = "John";
  expect(tmpl`
    [user]
      name = ${name}
  `).toBe("[user]\n  name = John\n");
});

describe("facts parsing", () => {
  test("os-release", () => {
    expect(parseOsRelease('NAME="CachyOS Linux"\nPRETTY_NAME="CachyOS"\nID=cachyos\nID_LIKE=arch\n')).toMatchObject({ family: "arch", id: "cachyos", name: "CachyOS" });
    expect(parseOsRelease('ID=debian\nVERSION_ID="13"\n').family).toBe("debian");
  });
  test("x86-64 levels", () => {
    const v2 = "cx16 lahf_lm popcnt sse4_1 sse4_2 ssse3";
    const v3 = `${v2} avx avx2 bmi1 bmi2 f16c fma abm movbe xsave`;
    expect(parseCpuInfo(`flags\t: ${v2}\n`, "x86_64").level).toBe("x86-64-v2");
    expect(parseCpuInfo(`flags\t: ${v3}\n`, "x86_64").level).toBe("x86-64-v3");
    expect(parseCpuInfo(`flags\t: ${v3} avx512f avx512bw avx512cd avx512dq avx512vl\n`, "x86_64").level).toBe("x86-64-v4");
    expect(parseCpuInfo("flags\t: sse\n", "x86_64").level).toBe("x86-64");
  });
});

describe("adopt", () => {
  test("insertLink into destructured params", () => {
    const src = `export const dev = module("dev", ({ pkg }) => {\n  pkg(["git"]);\n  file("~/.x", tmpl\`a{\${"}"}\`);\n});\n`;
    expect(insertLink(src, "dev", "~/.config/foo", "dotfiles/foo")).toBe(
      `export const dev = module("dev", ({ link, pkg }) => {\n  pkg(["git"]);\n  file("~/.x", tmpl\`a{\${"}"}\`);\n  link("~/.config/foo", "dotfiles/foo");\n});\n`,
    );
  });
  test("insertLink with a ctx identifier", () => {
    const src = `module("g", (ctx, opts = {}) => {\n  ctx.pkg(["x"]); // }\n});`;
    expect(insertLink(src, "g", "~/a", "dotfiles/a")).toBe(`module("g", (ctx, opts = {}) => {\n  ctx.pkg(["x"]); // }\n  ctx.link("~/a", "dotfiles/a");\n});`);
  });
  test("moves into the repo, links back, edits the module", async () => {
    const root = mkdtempSync(join(tmpdir(), "rig-adopt-"));
    const home = join(root, "home"), repo = join(root, "repo");
    mkdirSync(join(home, ".config/foo"), { recursive: true });
    mkdirSync(join(repo, "modules"), { recursive: true });
    writeFileSync(join(home, ".config/foo/settings"), "x");
    writeFileSync(join(repo, "modules/dev.ts"), `import { module } from "rig";\nexport const dev = module("dev", ({ pkg }) => {\n  pkg(["git"]);\n});\n`);
    const p = await planAdopt({ path: "~/.config/foo", repo, home, module: "dev" });
    await executeAdopt(p);
    expect(readlinkSync(join(home, ".config/foo"))).toBe(join(repo, "dotfiles/foo"));
    expect(lstatSync(join(repo, "dotfiles/foo/settings")).isFile()).toBe(true);
    expect(readFileSync(join(repo, "modules/dev.ts"), "utf8")).toContain(`  link("~/.config/foo", "dotfiles/foo");\n});`);
    await expect(planAdopt({ path: "~/.config/foo", repo, home })).rejects.toThrow("already a symlink");
  });
});

test("example config loads through the virtual rig module", async () => {
  const cfg = await loadConfig(join(import.meta.dir, "../example"));
  expect(Object.keys(cfg.hosts)).toEqual(["zephyr", "vault"]);
});
