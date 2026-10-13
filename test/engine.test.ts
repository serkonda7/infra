import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { module } from "../src/config/define.ts";
import { makeEnv, ops } from "./harness.ts";
import { summarize } from "../src/plan/plan.ts";

describe("files", () => {
  test("create, idempotent second run, prune on removal", async () => {
    const env = makeEnv();
    const m = module("m", (ctx) => {
      ctx.file("~/.config/app/a.conf", "a = 1\n");
      ctx.file(join(env.sys, "etc/b.conf"), { content: "b\n", mode: 0o600 });
    });
    const first = await env.apply([m]);
    expect(ops(first.plan)).toEqual([`create file:${env.home}/.config/app/a.conf`, `create file:${env.sys}/etc/b.conf`]);
    expect(first.failed).toBe(0);
    expect(readFileSync(join(env.home, ".config/app/a.conf"), "utf8")).toBe("a = 1\n");
    expect(statSync(join(env.sys, "etc/b.conf")).mode & 0o777).toBe(0o600);
    expect(first.generation.id).toBe(1);

    const second = await env.apply([m]);
    expect(ops(second.plan)).toEqual([]);
    expect(second.dirty).toBe(false);

    const third = await env.apply([module("m", () => {})]);
    expect(ops(third.plan)).toEqual([`destroy file:${env.home}/.config/app/a.conf`, `destroy file:${env.sys}/etc/b.conf`]);
    expect(existsSync(join(env.home, ".config/app/a.conf"))).toBe(false);
    expect(third.generation.id).toBe(2);
    expect(Object.keys(third.generation.resources)).toEqual([]);
  });

  test("update shows a diff; pre-existing file is backed up and restored on destroy", async () => {
    const env = makeEnv();
    const path = join(env.home, ".gitconfig");
    writeFileSync(path, "[user]\n  name = old\n");
    const m = module("m", (ctx) => void ctx.file("~/.gitconfig", "[user]\n  name = new\n"));
    const p = await env.plan([m]);
    const item = p.items[0]!;
    expect(item.op === "change" && item.action).toBe("update");
    expect(item.op === "change" && item.detail).toContain("-  name = old\n+  name = new");
    await env.apply([m]);
    expect(readFileSync(path, "utf8")).toBe("[user]\n  name = new\n");

    await env.apply([]);
    expect(readFileSync(path, "utf8")).toBe("[user]\n  name = old\n");
  });

  test("refuses to prune a file edited outside rig unless forced", async () => {
    const env = makeEnv();
    const path = join(env.home, "notes.txt");
    await env.apply([module("m", (ctx) => void ctx.file("~/notes.txt", "rig\n"))]);
    writeFileSync(path, "my edits\n");

    const r = await env.apply([]);
    expect(ops(r.plan)).toEqual([`blocked file:${path}`]);
    expect(readFileSync(path, "utf8")).toBe("my edits\n");
    expect(r.generation.resources[`file:${path}`]).toBeDefined(); // still owned

    await env.apply([], { force: true });
    expect(existsSync(path)).toBe(false);
  });

  test("identical pre-existing file is adopted and kept on destroy", async () => {
    const env = makeEnv();
    const path = join(env.home, "same.txt");
    writeFileSync(path, "x\n");
    const r = await env.apply([module("m", (ctx) => void ctx.file("~/same.txt", "x\n"))]);
    expect(ops(r.plan)).toEqual([]);
    expect(r.dirty).toBe(true); // ownership recorded even with no changes
    const gone = await env.apply([]);
    expect(ops(gone.plan)).toEqual([`forget file:${path}`]);
    expect(readFileSync(path, "utf8")).toBe("x\n");
  });
});

describe("links", () => {
  test("link, link.tree, prune", async () => {
    const env = makeEnv();
    mkdirSync(join(env.repo, "dotfiles/nvim"), { recursive: true });
    mkdirSync(join(env.repo, "dotfiles/home/.config/fish"), { recursive: true });
    writeFileSync(join(env.repo, "dotfiles/home/.config/fish/config.fish"), "");
    writeFileSync(join(env.repo, "dotfiles/home/.config/fish/secret.local"), "");
    writeFileSync(join(env.repo, "dotfiles/home/.bashrc"), "");
    const m = module("m", (ctx) => {
      ctx.link("~/.config/nvim", "dotfiles/nvim");
      ctx.link.tree("dotfiles/home", "~", { ignore: ["**/*.local"] });
    });
    const r = await env.apply([m]);
    expect(ops(r.plan)).toEqual([
      `create link:${env.home}/.bashrc`,
      `create link:${env.home}/.config/fish/config.fish`,
      `create link:${env.home}/.config/nvim`,
    ]);
    expect(readlinkSync(join(env.home, ".config/nvim"))).toBe(join(env.repo, "dotfiles/nvim"));
    expect(ops(await env.plan([m]))).toEqual([]);

    await env.apply([]);
    expect(existsSync(join(env.home, ".config/nvim"))).toBe(false);
    expect(existsSync(join(env.home, ".bashrc"))).toBe(false);
  });

  test("existing file blocks a link; --force moves it aside and destroy moves it back", async () => {
    const env = makeEnv();
    writeFileSync(join(env.repo, "rc"), "repo\n");
    writeFileSync(join(env.home, ".rc"), "mine\n");
    const m = module("m", (ctx) => void ctx.link("~/.rc", "rc"));
    const blocked = await env.apply([m]);
    expect(ops(blocked.plan)).toEqual([`blocked link:${env.home}/.rc`]);
    expect(blocked.generation.status).toBe("partial");

    await env.apply([m], { force: true });
    expect(lstatSync(join(env.home, ".rc")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(env.home, ".rc.rig-orig"), "utf8")).toBe("mine\n");

    await env.apply([]);
    expect(readFileSync(join(env.home, ".rc"), "utf8")).toBe("mine\n");
    expect(lstatSync(join(env.home, ".rc")).isSymbolicLink()).toBe(false);
  });

  test("leaves a link alone if it was retargeted by the user", async () => {
    const env = makeEnv();
    writeFileSync(join(env.repo, "rc"), "");
    await env.apply([module("m", (ctx) => void ctx.link("~/.rc", "rc"))]);
    const { symlinkSync, unlinkSync } = await import("node:fs");
    unlinkSync(join(env.home, ".rc"));
    symlinkSync("/elsewhere", join(env.home, ".rc"));
    const r = await env.apply([]);
    expect(ops(r.plan)).toEqual([`forget link:${env.home}/.rc`]);
    expect(readlinkSync(join(env.home, ".rc"))).toBe("/elsewhere");
  });
});

describe("dirs", () => {
  test("dir is ordered before files inside it; removed only if empty", async () => {
    const env = makeEnv();
    const m = module("m", (ctx) => {
      ctx.file(join(env.sys, "opt/app/conf"), "x");
      ctx.dir(join(env.sys, "opt/app"), { mode: 0o750 });
    });
    const r = await env.apply([m]);
    expect(r.events.map((e) => e.item.id)).toEqual([`dir:${env.sys}/opt/app`, `file:${env.sys}/opt/app/conf`]);
    expect(statSync(join(env.sys, "opt/app")).mode & 0o777).toBe(0o750);
    await env.apply([]);
    expect(existsSync(join(env.sys, "opt/app"))).toBe(false);
  });
});

describe("packages", () => {
  test("batched install, adopt existing, mark explicit, additive pruning", async () => {
    const env = makeEnv();
    env.pacman.installed.set("htop", true); // installed before rig
    env.pacman.installed.set("fd", false); // installed as a dependency
    const m = module("m", (ctx) => void ctx.pkg(["git", "neovim", "htop", "fd"]));
    const r = await env.apply([m]);
    expect(ops(r.plan)).toEqual(["create pkg:pacman:git", "create pkg:pacman:neovim", "update pkg:pacman:fd"]);
    const installs = env.system.calls.filter((c) => c[1] === "-S");
    expect(installs).toEqual([["pacman", "-S", "--needed", "--noconfirm", "git", "neovim"]]); // one transaction
    expect(env.pacman.installed.get("fd")).toBe(true);

    const removed = await env.apply([module("m", (ctx) => void ctx.pkg(["git"]))]);
    expect(ops(removed.plan)).toEqual(["destroy pkg:pacman:fd", "destroy pkg:pacman:neovim", "forget pkg:pacman:htop"]);
    expect(env.pacman.installed.has("neovim")).toBe(false);
    expect(env.pacman.installed.get("fd")).toBe(false); // demoted back to a dependency
    expect(env.pacman.installed.get("htop")).toBe(true); // never ours to remove
  });

  test("package still required by others is demoted instead", async () => {
    const env = makeEnv();
    await env.apply([module("m", (ctx) => void ctx.pkg(["git", "ripgrep"]))]);
    env.pacman.required.add("git");
    const r = await env.apply([]);
    expect(r.failed).toBe(0);
    expect(env.pacman.installed.has("ripgrep")).toBe(false);
    expect(env.pacman.installed.get("git")).toBe(false);
  });

  test("failed install skips dependents and keeps nothing it didn't own", async () => {
    const env = makeEnv();
    env.pacman.repo.delete("steam"); // validation is skipped in the harness; install fails
    const m = module("m", (ctx) => {
      ctx.pkg(["steam"]);
      ctx.file("~/.steamrc", "x", { after: ["pkg:pacman:steam"] });
    });
    const r = await env.apply([m]);
    expect(r.failed).toBe(2);
    expect(r.events.find((e) => e.item.id.startsWith("file:"))?.skipped).toBe(true);
    expect(r.generation.status).toBe("partial");
    expect(r.generation.resources).toEqual({});
  });

  test("validation rejects unknown packages and groups", async () => {
    const env = makeEnv();
    const { pacmanType } = await import("../src/resources/pacman.ts");
    const errs = await pacmanType.validate!([{ name: "git" }, { name: "nope" }, { name: "plasma" }], { facts: env.facts, x: env.x, ids: new Set() });
    expect(errs).toHaveLength(2);
    expect(errs[0]).toContain("nope");
    expect(errs[1]).toContain("group");
  });
});

describe("exec", () => {
  test("guards and onChange triggers", async () => {
    const env = makeEnv();
    const m = (content: string) =>
      module("m", (ctx) => {
        const f = ctx.file("~/.conf", content);
        ctx.exec("reload-it", { onChange: [f], asUser: true });
        ctx.exec("make-thing", { creates: "~/thing", asUser: true });
        ctx.exec("check-thing", { unless: "true", asUser: true });
      });
    const first = await env.apply([m("1")]);
    const ran = () => env.user.calls.filter((c) => c[0] === "sh" && !["true"].includes(c[2]!)).map((c) => c[2]);
    expect(ran()).toEqual(["make-thing", "reload-it"]); // reload-it waits for its trigger

    env.user.calls.length = 0;
    writeFileSync(join(env.home, "thing"), "");
    expect(ops(await env.plan([m("1")]))).toEqual([]);
    await env.apply([m("2")]);
    expect(ran()).toEqual(["reload-it"]);
    expect(first.failed).toBe(0);
  });
});

describe("filters", () => {
  test("rig dot only touches user scope and carries system resources over", async () => {
    const env = makeEnv();
    const full = module("m", (ctx) => {
      ctx.pkg(["git"]);
      ctx.file("~/.a", "a");
      ctx.file(join(env.sys, "etc/x"), "x");
    });
    await env.apply([full]);
    const dot = await env.apply([module("m", (ctx) => void ctx.file("~/.a", "a2"))], { userOnly: true });
    expect(ops(dot.plan)).toEqual([`update file:${env.home}/.a`]); // system file & package not pruned
    expect(Object.keys(dot.generation.resources)).toContain(`file:${env.sys}/etc/x`);
    expect(Object.keys(dot.generation.resources)).toContain("pkg:pacman:git");
    expect(env.system.calls.filter((c) => c[0] === "pacman" && c[1] === "-Rns")).toEqual([]);
  });

  test("--only matches module names", async () => {
    const env = makeEnv();
    const a = module("a", (ctx) => void ctx.file("~/.a", "a"));
    const b = module("b", (ctx) => void ctx.file("~/.b", "b"));
    const r = await env.apply([a, b], { only: "b" });
    expect(ops(r.plan)).toEqual([`create file:${env.home}/.b`]);
  });
});

describe("evaluation", () => {
  test("conflicting declarations name both sites; equal ones merge", () => {
    const env = makeEnv();
    const { evaluate } = require("../src/config/context.ts");
    const { host } = require("../src/config/define.ts");
    const ok = evaluate(host({ os: "arch", modules: [module("a", (ctx) => void ctx.pkg(["git"])), module("b", (ctx) => void ctx.pkg(["git"]))] }), { facts: env.facts, repo: env.repo, hostName: "t" });
    ok.finalize();
    expect(ok.errors).toEqual([]);
    expect(ok.decls.get("pkg:pacman:git").provenance.map((p: any) => p.modules[0])).toEqual(["a", "b"]);

    const bad = evaluate(host({ os: "arch", modules: [module("a", (ctx) => void ctx.file("~/x", "1")), module("b", (ctx) => void ctx.file("~/x", "2"))] }), { facts: env.facts, repo: env.repo, hostName: "t" });
    expect(bad.errors[0]).toContain("conflicting declarations");
    expect(bad.errors[0]).toMatch(/a \(\S*engine\.test\.ts:\d+\)/);
  });

  test("cycles, unknown deps, paths inside linked dirs", () => {
    const env = makeEnv();
    mkdirSync(join(env.repo, "nvim"));
    const { evaluate } = require("../src/config/context.ts");
    const { host } = require("../src/config/define.ts");
    const g = evaluate(
      host({
        os: "arch",
        modules: [
          module("m", (ctx) => {
            ctx.file("~/a", "a", { after: [`file:${env.home}/b`] });
            ctx.file("~/b", "b", { after: [`file:${env.home}/a`] });
            ctx.file("~/c", "c", { after: ["pkg:pacman:missing"] });
            ctx.link("~/.config/nvim", "nvim");
            ctx.file("~/.config/nvim/init.lua", "x");
          }),
        ],
      }),
      { facts: env.facts, repo: env.repo, hostName: "t" },
    );
    g.finalize();
    const all = g.errors.join("\n");
    expect(all).toContain("unknown resource pkg:pacman:missing");
    expect(all).toContain("inside the linked directory");
    expect(all).toContain("dependency cycle");
  });

  test("summary counts", async () => {
    const env = makeEnv();
    const p = await env.plan([module("m", (ctx) => void ctx.file("~/a", "a"))]);
    expect(summarize(p)).toMatchObject({ add: 1, change: 0, destroy: 0, actionable: true });
  });
});
