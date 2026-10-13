import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { module } from "../src/config/define.ts";
import { evaluateHost, loadTarget } from "../src/engine.ts";
import { spawn } from "../src/exec/local.ts";
import { parseFacts } from "../src/facts/index.ts";
import { why } from "../src/cli/why.ts";
import { status } from "../src/cli/status.ts";
import { rollback } from "../src/cli/rollback.ts";
import { runApply } from "../src/cli/run.ts";
import type { Session } from "../src/cli/session.ts";
import { ok } from "../src/exec/fake.ts";
import { makeEnv } from "./harness.ts";

const EXAMPLE = join(import.meta.dir, "../example");

const quiet: Session = { plan() {}, confirm: async () => true, sudo: async () => true, info() {}, warn() {}, event() {}, done() {} };

/** A config repo on disk (what the CLI commands load), with `rig` resolved by loadConfig. */
function writeConfig(dir: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "rig.config.ts"), `import { defineConfig, host, module } from "rig";\n${body}\n`);
}

describe("example config", () => {
  test("both hosts evaluate", async () => {
    for (const [host, os] of [["zephyr", "arch"], ["vault", "debian"]] as const) {
      const { facts } = makeEnv({ os });
      const g = evaluateHost(await loadTarget({ configDir: EXAMPLE, host, facts }), facts);
      g.finalize();
      expect(g.errors).toEqual([]);
      if (host === "zephyr") expect(g.decls.has("pkg:flatpak:org.mozilla.firefox")).toBe(true);
      if (host === "vault") expect(g.decls.has("pkg:apt:fd-find")).toBe(true); // alias resolved with the host's facts
    }
  });

  test("parseFacts rejects anything that isn't rig facts", () => {
    expect(parseFacts(JSON.stringify(makeEnv().facts), "facts.json").os.family).toBe("arch");
    expect(() => parseFacts("{}", "x.json")).toThrow("doesn't look like rig facts");
  });
});

describe("why", () => {
  test("by ID, name or path: declaration sites, dependencies and dependents", async () => {
    const env = makeEnv();
    const g = env.evalHost([
      module("dev", (ctx) => {
        ctx.pkg(["docker"]);
        ctx.unit("docker", { started: true });
        ctx.user.groups(["docker"]);
      }),
      module("other", (ctx) => void ctx.pkg(["docker"])),
    ]);
    g.finalize();
    const ctx = { host: "testhost", home: env.home, repo: env.repo };
    const r = why(g, null, "pkg:pacman:docker", ctx);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.declaredBy.map((p) => p.modules.join(">"))).toEqual(["dev", "other"]);
    expect(r.matches[0]!.declaredBy[0]!.site).toMatch(/cli\.test\.ts:\d+$/);
    expect(r.matches[0]!.dependents.sort()).toEqual(["member:tester:docker", "unit:system:docker.service"]);

    expect(why(g, null, "docker.service", ctx).matches.map((m) => m.id)).toEqual(["unit:system:docker.service"]);
    expect(why(g, null, "unit:*", ctx).matches.map((m) => m.deps)).toEqual([["pkg:pacman:docker"]]);
    expect(why(g, null, "docker", ctx).matches.map((m) => m.id).sort()).toEqual(["member:tester:docker", "pkg:pacman:docker"]);
  });

  test("paths, and resources only the last generation still owns", async () => {
    const env = makeEnv();
    await env.apply([module("m", (ctx) => void ctx.file("~/.old", "x"))]);
    const g = env.evalHost([module("m", (ctx) => void ctx.file("~/.config/a.conf", "a"))]);
    g.finalize();
    const ctx = { host: "testhost", home: env.home, repo: env.repo };
    expect(why(g, null, "~/.config/a.conf", ctx).matches.map((m) => m.id)).toEqual([`file:${env.home}/.config/a.conf`]);
    const gone = why(g, await env.state.latest("testhost"), "~/.old", ctx);
    expect(gone.matches).toEqual([]);
    expect(gone.owned).toEqual([{ id: `file:${env.home}/.old`, display: "~/.old", generation: 1 }]);
  });
});

describe("generations", () => {
  test("gc keeps the newest generations per host and the backups they refer to", async () => {
    const env = makeEnv();
    const objects = env.state.objects();
    const refs: string[] = [];
    for (let id = 1; id <= 5; id++) {
      const ref = await objects.put(new TextEncoder().encode(`backup ${id}`));
      refs.push(ref);
      await env.state.write({ id, at: "", host: "a", commit: null, status: "ok", resources: { [`file:/x${id}`]: { kind: "file", scope: "system", display: "", meta: { hash: "", backup: ref } } } });
    }
    await env.state.write({ id: 1, at: "", host: "b", commit: null, status: "ok", resources: {} });
    const r = await env.state.gc(2);
    expect(r.generations).toEqual([1, 2, 3].map((id) => ({ host: "a", id })));
    expect(r.objects).toBe(3);
    expect(await env.state.list("a")).toEqual([4, 5]);
    expect(await env.state.list("b")).toEqual([1]);
    expect(await objects.get(refs[3]!)).not.toBeNull();
    expect(await objects.get(refs[0]!)).toBeNull();
  });

  test("rollback re-applies an old commit from a worktree; links keep pointing into the working copy", async () => {
    const env = makeEnv();
    const repo = env.repo;
    const git = async (...args: string[]) => {
      const r = await spawn(["git", "-C", repo, ...args], { env: { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
      if (r.code !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    writeConfig(repo, `export default defineConfig({ hosts: { testhost: host({ os: "arch", modules: [module("m", (ctx) => { ctx.file("~/out", { source: "content.txt" }); ctx.link("~/linked", "content.txt"); })] }) } });`);
    writeFileSync(join(repo, "content.txt"), "one\n");
    await git("init", "-q", "-b", "main");
    await git("add", ".");
    await git("commit", "-qm", "one");
    const c1 = await git("rev-parse", "--short", "HEAD");
    const run = { engine: { configDir: repo, facts: env.facts, x: env.x, stateDir: env.state.dir, fast: true } };
    expect(await runApply(run, quiet)).toBe(0);

    writeFileSync(join(repo, "content.txt"), "two\n");
    await git("commit", "-qam", "two");
    expect(await runApply(run, quiet)).toBe(0);
    expect(readFileSync(join(env.home, "out"), "utf8")).toBe("two\n");

    expect(await rollback({ n: 1, host: "testhost", repo, state: env.state, run }, quiet)).toBe(0);
    expect(readFileSync(join(env.home, "out"), "utf8")).toBe("one\n");
    expect(readlinkSync(join(env.home, "linked"))).toBe(join(repo, "content.txt"));
    const g3 = (await env.state.latest("testhost"))!;
    expect(g3).toMatchObject({ id: 3, commit: c1, rollbackOf: 1 });
    expect((await git("worktree", "list")).split("\n")).toHaveLength(1); // temporary worktree cleaned up

    await expect(rollback({ n: 9, host: "testhost", repo, state: env.state, run }, quiet)).rejects.toThrow("no generation 9 for testhost");
  });
});

describe("status", () => {
  test("generation, drift, pending .pacnew files, failed units", async () => {
    const env = makeEnv();
    const conf = join(env.sys, "etc/app.conf");
    writeConfig(env.repo, `export default defineConfig({ hosts: { testhost: host({ os: "arch", modules: [module("m", (ctx) => { ctx.file(${JSON.stringify(conf)}, "v1\\n"); ctx.file("~/.rc", "rc\\n"); })] }) } });`);
    const engine = { configDir: env.repo, facts: env.facts, x: env.x, stateDir: env.state.dir };
    expect(await runApply({ engine: { ...engine, fast: true } }, quiet)).toBe(0);

    writeFileSync(join(env.home, ".rc"), "edited\n");
    writeFileSync(conf + ".pacnew", "v2\n");
    writeFileSync(join(env.sys, "etc/other.conf.pacnew"), "");
    env.user.handlers.unshift((argv) => {
      if (argv[0] === "find") return spawn(argv);
      if (argv[0] === "systemctl" && argv.includes("--failed")) return ok(argv[1] === "--user" ? "" : "samba.service loaded failed failed Samba SMB Daemon\n");
    });

    const s = await status(engine, { etc: join(env.sys, "etc") });
    expect(s.generation).toMatchObject({ id: 1, status: "ok", resources: 2 });
    expect(s.drift.items.map((i) => `${i.op} ${i.display}`)).toEqual(["update ~/.rc"]);
    expect(s.pending).toEqual([
      { path: conf + ".pacnew", managed: true },
      { path: join(env.sys, "etc/other.conf.pacnew"), managed: false },
    ]);
    expect(s.failedUnits).toEqual([{ name: "samba.service", user: false }]);
    expect(existsSync(conf)).toBe(true);
  });
});
