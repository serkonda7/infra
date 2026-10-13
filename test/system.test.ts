import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { module } from "../src/config/define.ts";
import { makeEnv, mutations, ops } from "./harness.ts";
import { HelperExecutor, selfCommand } from "../src/exec/helper.ts";
import { FakeExecutor, ok, fail } from "../src/exec/fake.ts";
import { snapshotter } from "../src/apply/snapshot.ts";
import { planAdoptPackages } from "../src/cli/adopt.ts";
import { edit, unedit } from "../src/resources/line.ts";
import { removeSection, sectionBody, setSection } from "../src/resources/repo.ts";
import { aurType } from "../src/resources/pacman.ts";

describe("triggers & sysctl", () => {
  test("sysctl values merge into one file; sysctl --system runs once, at the end", async () => {
    const env = makeEnv();
    const conf = join(env.sys, "etc/sysctl.d/90-rig.conf");
    const a = module("a", ({ sysctl, file }) => {
      sysctl({ "vm.swappiness": 10 });
      file("~/.later", "x");
    });
    const b = module("b", ({ sysctl }) => void sysctl({ "vm.max_map_count": 2147483642 }));
    const r = await env.apply([a, b]);
    expect(r.failed).toBe(0);
    expect(readFileSync(conf, "utf8")).toBe("# Managed by rig — merged from sysctl() calls.\nvm.max_map_count = 2147483642\nvm.swappiness = 10\n");
    expect(r.events.at(-1)!.item.display).toBe("# sysctl --system");
    expect(mutations(env.system.calls).filter((c) => c.includes("sysctl"))).toEqual(["sh -c sysctl --system"]);

    env.system.calls.length = 0;
    const again = await env.apply([a, b]);
    expect(ops(again.plan)).toEqual([]);
    expect(env.system.calls.filter((c) => c[2] === "sysctl --system")).toEqual([]);
  });

  test("conflicting sysctl values name the other site", () => {
    const env = makeEnv();
    const g = env.evalHost([module("a", ({ sysctl }) => void sysctl({ "vm.swappiness": 10 })), module("b", ({ sysctl }) => void sysctl({ "vm.swappiness": 60 }))]);
    expect(g.errors[0]).toMatch(/vm\.swappiness = 60 conflicts with 10 from a \(\S+system\.test\.ts:\d+\)/);
  });

  test("trigger declared twice merges its subscriptions and fires once", async () => {
    const env = makeEnv();
    const m = (v: string) =>
      module("m", ({ file, trigger }) => {
        trigger("reload-a", { on: [file("~/a", v)], asUser: true });
        trigger("reload-a", { on: [file("~/b", "b")], asUser: true });
      });
    await env.apply([m("1")]);
    expect(env.user.calls.filter((c) => c[2] === "reload-a")).toHaveLength(1);
    env.user.calls.length = 0;
    const r = await env.apply([m("2")]);
    expect(ops(r.plan)).toEqual([expect.stringMatching(/^run trigger:/), `update file:${env.home}/a`]);
    expect(env.user.calls.filter((c) => c[2] === "reload-a")).toHaveLength(1);
  });
});

describe("units", () => {
  test("enable + start after the module's package; prune undoes only what rig did", async () => {
    const env = makeEnv();
    env.systemd.add("docker.service");
    env.systemd.add("sshd.service", "enabled", "active"); // already on before rig
    const m = module("dev", ({ pkg, unit }) => {
      pkg(["docker"]);
      unit("docker", { started: true });
      unit("sshd.service", { started: true });
    });
    const r = await env.apply([m]);
    expect(ops(r.plan)).toEqual(["create pkg:pacman:docker", "update unit:system:docker.service"]);
    expect(r.plan.items.find((i) => i.id === "unit:system:docker.service")?.op === "change" && (r.plan.items.find((i) => i.id === "unit:system:docker.service") as any).deps).toEqual(["pkg:pacman:docker"]);
    expect(env.systemd.get("docker.service")).toEqual({ state: "enabled", active: "active" });
    expect(ops(await env.plan([m]))).toEqual([]);

    const gone = await env.apply([]);
    expect(ops(gone.plan)).toEqual(["destroy pkg:pacman:docker", "destroy unit:system:docker.service", "forget unit:system:sshd.service"]);
    expect(env.systemd.get("docker.service")).toEqual({ state: "disabled", active: "inactive" });
    expect(env.systemd.get("sshd.service")).toEqual({ state: "enabled", active: "active" });
  });

  test("unit.define writes the file, reloads before enabling, restartOn fires at the end", async () => {
    const env = makeEnv();
    const m = (exec: string) =>
      module("svc", ({ unit, file }) => {
        const conf = file(join(env.sys, "etc/app.conf"), "x");
        unit.define("app.service", `[Service]\nExecStart=${exec}\n[Install]\nWantedBy=multi-user.target\n`);
        unit("app", { started: true, restartOn: [conf] });
      });
    env.systemd.add("app.service"); // what systemd would see after the reload
    const r = await env.apply([m("/bin/app")]);
    expect(r.failed).toBe(0);
    expect(readFileSync(join(env.sys, "etc/systemd/system/app.service"), "utf8")).toContain("ExecStart=/bin/app");
    const cmds = mutations(env.system.calls);
    expect(cmds.indexOf("systemctl daemon-reload")).toBeLessThan(cmds.indexOf("systemctl enable -- app.service"));
    expect(cmds.at(-1)).toBe("sh -c systemctl try-restart app.service");

    env.system.calls.length = 0;
    await env.apply([m("/bin/app2")]);
    expect(mutations(env.system.calls)).toEqual(["sh -c systemctl daemon-reload"]); // unit itself unchanged; conf unchanged → no restart
  });

  test("user units go through the user executor; masked units block", async () => {
    const env = makeEnv();
    env.systemd.add("syncthing.service", "disabled", "inactive", true);
    env.systemd.add("bad.service", "masked");
    const r = await env.apply([module("m", ({ unit }) => (unit("syncthing", { user: true, started: true }), void unit("bad")))]);
    expect(env.user.calls.map((c) => c.join(" "))).toContain("systemctl --user enable -- syncthing.service");
    expect(ops(r.plan)).toContain("blocked unit:system:bad.service");
  });
});

describe("accounts", () => {
  test("user.groups batches usermod, comes after the package that creates the group, and is pruned", async () => {
    const env = makeEnv();
    env.accounts.groups.set("docker", { gid: 970, members: [] });
    const m = module("dev", ({ pkg, user }) => {
      pkg(["docker"]);
      user.groups(["docker", "wheel"]);
    });
    const r = await env.apply([m]);
    expect(ops(r.plan)).toEqual(["create member:tester:docker", "create pkg:pacman:docker"]); // wheel: already a member
    expect(mutations(env.system.calls)).toEqual(["pacman -S --needed --noconfirm docker", "usermod --append --groups docker -- tester"]);
    expect(r.events.find((e) => e.item.id === "member:tester:docker")?.note).toBe("takes effect at next login");

    const gone = await env.apply([]);
    expect(ops(gone.plan)).toEqual(["destroy member:tester:docker", "destroy pkg:pacman:docker", "forget member:tester:wheel"]);
    expect(env.accounts.groups.get("docker")!.members).toEqual([]);
    expect(env.accounts.groups.get("wheel")!.members).toEqual(["tester"]);
  });

  test("accounts and groups are created, but only deleted with prune: true", async () => {
    const env = makeEnv();
    const m = (prune: boolean) =>
      module("srv", ({ user, group }) => {
        group("media", { system: true, prune });
        user("jelly", { system: true, shell: "/usr/bin/nologin", groups: ["media"], prune });
      });
    const r = await env.apply([m(false)]);
    expect(r.failed).toBe(0);
    expect(env.accounts.users.get("jelly")?.shell).toBe("/usr/bin/nologin");
    expect(env.accounts.groups.get("media")?.members).toEqual(["jelly"]);
    const kept = await env.apply([]);
    expect(ops(kept.plan)).toEqual(["destroy member:jelly:media", "forget group:media", "forget user:jelly"]);
    expect(env.accounts.users.has("jelly")).toBe(true);

    await env.apply([m(true)]);
    await env.apply([]);
    expect(env.accounts.users.has("jelly")).toBe(true); // re-adopted, not created by rig this time
  });

  test("shell change is restored on destroy", async () => {
    const env = makeEnv();
    await env.apply([module("m", ({ user }) => void user("tester", { shell: "/usr/bin/fish" }))]);
    expect(env.accounts.users.get("tester")!.shell).toBe("/usr/bin/fish");
    await env.apply([]);
    expect(env.accounts.users.get("tester")!.shell).toBe("/bin/bash");
  });
});

describe("lineInFile", () => {
  test("edit/unedit", () => {
    expect(edit("a\nb\n", { text: "c", block: false, key: "c", comment: "#" }).content).toBe("a\nb\nc\n");
    expect(edit("a\n#Color\n", { text: "Color", match: "^#?Color$", block: false, key: "c", comment: "#" })).toEqual({ content: "a\nColor\n", original: "#Color" });
    expect(edit("x = 1\n", { text: "x = 2", block: false, key: "x", comment: "#" }, "x = 1").content).toBe("x = 2\n");
    const blk = edit("top", { text: "one\ntwo", block: true, key: "k", comment: "#" }).content;
    expect(blk).toBe("top\n# BEGIN rig k\none\ntwo\n# END rig k\n");
    expect(edit(blk, { text: "three", block: true, key: "k", comment: "#" }).content).toBe("top\n# BEGIN rig k\nthree\n# END rig k\n");
    expect(unedit(blk, { text: "", block: true, key: "k", comment: "#" })).toBe("top\n");
    expect(unedit("a\nColor\n", { text: "Color", original: "#Color", block: false, key: "c", comment: "#" })).toBe("a\n#Color\n");
  });

  test("several edits to one file are written once and undone on removal", async () => {
    const env = makeEnv();
    const path = join(env.sys, "etc/pacman.conf");
    mkdirSync(join(env.sys, "etc"), { recursive: true });
    writeFileSync(path, "[options]\n#Color\n#ParallelDownloads = 5\n");
    const m = module("m", ({ lineInFile }) => {
      lineInFile(path, { line: "Color", match: /^#?Color$/ });
      lineInFile(path, { line: "ParallelDownloads = 10", match: /^#?ParallelDownloads/ });
      lineInFile(path, { block: "ILoveCandy", key: "candy" });
    });
    const r = await env.apply([m]);
    expect(r.failed).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("[options]\nColor\nParallelDownloads = 10\n# BEGIN rig candy\nILoveCandy\n# END rig candy\n");
    expect(ops(await env.plan([m]))).toEqual([]);
    await env.apply([]);
    expect(readFileSync(path, "utf8")).toBe("[options]\n#Color\n#ParallelDownloads = 5\n");
  });

  test("a line that was already there is kept on removal; a fully managed path can't also be edited", async () => {
    const env = makeEnv();
    writeFileSync(join(env.home, ".profile"), "export A=1\n");
    await env.apply([module("m", ({ lineInFile }) => void lineInFile("~/.profile", "export A=1"))]);
    await env.apply([]);
    expect(readFileSync(join(env.home, ".profile"), "utf8")).toBe("export A=1\n");

    const g = env.evalHost([module("m", ({ file, lineInFile }) => (file("~/x", "a"), void lineInFile("~/x", "b")))]);
    g.finalize();
    expect(g.errors.join()).toContain("fully managed as file:");
  });
});

describe("pacman repos", () => {
  const conf = "[options]\nArchitecture = auto\n\n[core]\nInclude = /etc/pacman.d/mirrorlist\n\n[extra]\nInclude = /etc/pacman.d/mirrorlist\n";

  test("section helpers", () => {
    const first = setSection(conf, "cachyos", ["Include = /etc/pacman.d/cachyos-mirrorlist"], "first");
    expect(first).toContain("Architecture = auto\n\n[cachyos]\nInclude = /etc/pacman.d/cachyos-mirrorlist\n\n[core]");
    expect(sectionBody(first, "cachyos")).toEqual(["Include = /etc/pacman.d/cachyos-mirrorlist"]);
    expect(removeSection(first, "cachyos")).toBe(conf);
    expect(setSection(conf, "local", ["Server = file:///srv/repo"], "last")).toBe(conf + "\n[local]\nServer = file:///srv/repo\n");
  });

  test("adds a section with keys, syncs, installs with -Su, removes it again", async () => {
    const env = makeEnv();
    const path = join(env.sys, "etc/pacman.conf");
    mkdirSync(join(env.sys, "etc"), { recursive: true });
    writeFileSync(path, conf);
    env.pacman.repos = ["core", "extra"];
    const m = module("m", ({ pkg }) => {
      pkg.repo("cachyos", { include: "/etc/pacman.d/cachyos-mirrorlist", position: "first", keys: ["F3B607488DB35A47"], keyserver: "keyserver.ubuntu.com" });
      pkg(["git"]);
    });
    const r = await env.apply([m]);
    expect(r.failed).toBe(0);
    expect(sectionBody(readFileSync(path, "utf8"), "cachyos")).toEqual(["Include = /etc/pacman.d/cachyos-mirrorlist"]);
    expect(mutations(env.system.calls)).toEqual([
      "pacman-key --recv-keys F3B607488DB35A47 --keyserver keyserver.ubuntu.com",
      "pacman-key --lsign-key F3B607488DB35A47",
      "pacman -Sy",
      "pacman -Su --needed --noconfirm git",
    ]);
    expect(ops(await env.plan([m]))).toEqual([]);
    await env.apply([module("m", ({ pkg }) => void pkg(["git"]))]);
    expect(readFileSync(path, "utf8")).toBe(conf);
  });
});

describe("AUR", () => {
  test("bootstraps paru, builds as the user, depends on base-devel", async () => {
    const env = makeEnv();
    const m = module("m", ({ pkg }) => void pkg.aur(["visual-studio-code-bin"]));
    const r = await env.apply([m]);
    expect(r.failed).toBe(0);
    expect(ops(r.plan)).toEqual(["create pkg:aur:visual-studio-code-bin", "create pkg:pacman:base-devel"]);
    expect(mutations(env.system.calls)).toEqual(["pacman -S --needed --noconfirm base-devel", "pacman -S --needed --noconfirm paru"]);
    expect(mutations(env.user.calls)).toEqual(["paru -S --needed --noconfirm --skipreview visual-studio-code-bin"]);
    expect(ops(await env.plan([m]))).toEqual([]);
    await env.apply([]);
    expect(env.pacman.installed.has("visual-studio-code-bin")).toBe(false);
  });

  test("validation rejects repo packages declared as AUR", async () => {
    const env = makeEnv();
    const errs = await aurType.validate!([{ name: "git" }, { name: "yay-bin" }], { facts: env.facts, x: env.x, ids: new Set() });
    expect(errs).toEqual(["pkg:aur:git is in the sync repos — declare it with pkg() instead"]);
  });
});

describe("exact package mode", () => {
  test("removes undeclared explicit packages except base and keep globs", async () => {
    const env = makeEnv();
    for (const n of ["base", "git", "htop", "linux-cachyos", "yay-bin"]) env.pacman.installed.set(n, true);
    env.pacman.installed.set("fd", false); // dependency: not considered
    env.pacman.foreign.add("yay-bin");
    const m = module("m", ({ pkg }) => void pkg(["git"]));
    const p = await env.plan([m], { packages: { mode: "exact", keep: ["linux-*"] } });
    expect(ops(p)).toEqual(["destroy pkg:aur:yay-bin", "destroy pkg:pacman:htop"]);
    expect(p.warnings.join()).toContain("2 undeclared packages will be removed");

    const additive = await env.plan([m]);
    expect(ops(additive)).toEqual([]);

    await env.apply([m], { packages: { mode: "exact", keep: ["linux-*"] }, demote: true });
    expect(env.pacman.installed.get("htop")).toBe(false);
    expect(env.pacman.installed.get("yay-bin")).toBe(false);
    expect(env.pacman.installed.get("linux-cachyos")).toBe(true);
  });
});

describe("kernelParams", () => {
  test("merged into a block in /etc/default/limine; kernel packages also regenerate entries", async () => {
    const env = makeEnv();
    const conf = join(env.sys, "etc/default/limine");
    mkdirSync(join(env.sys, "etc/default"), { recursive: true });
    writeFileSync(conf, 'KERNEL_CMDLINE[default]+="quiet rw"\n');
    const m = module("m", ({ kernelParams, pkg }) => {
      kernelParams(["nowatchdog"]);
      kernelParams(["zswap.enabled=0", "nowatchdog"]);
      pkg(["linux-cachyos"]);
    });
    const g = env.evalHost([m]);
    const trig = [...g.decls.values()].find((d) => d.type.kind === "trigger")!;
    expect(trig.spec.cmd).toBe("limine-update");
    expect(trig.spec.on).toEqual([`line:${conf}#kernelParams`, "pkg:pacman:linux-cachyos"]);

    const r = await env.apply([m]);
    expect(r.failed).toBe(0);
    expect(readFileSync(conf, "utf8")).toBe('KERNEL_CMDLINE[default]+="quiet rw"\n# BEGIN rig kernelParams\nKERNEL_CMDLINE[default]+=" nowatchdog zswap.enabled=0"\n# END rig kernelParams\n');
    expect(mutations(env.system.calls).at(-1)).toBe("sh -c limine-update");
  });

  test("unsupported boot loader is an evaluation error", () => {
    const env = makeEnv();
    env.facts.boot.loader = "unknown";
    const g = env.evalHost([module("m", ({ kernelParams }) => void kernelParams(["quiet"]))]);
    expect(g.errors[0]).toContain('unsupported boot loader "unknown"');
  });
});

describe("privileged helper", () => {
  test("round-trips executor operations and errno codes over NDJSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rig-helper-"));
    const x = new HelperExecutor(selfCommand()); // no sudo in tests
    try {
      await x.writeFile(join(dir, "a/b.txt"), new TextEncoder().encode("hi\0there"), 0o640);
      expect(await x.readFile(join(dir, "a/b.txt"))).toEqual(new TextEncoder().encode("hi\0there"));
      expect(await x.lstat(join(dir, "a/b.txt"))).toEqual({ type: "file", mode: 0o640 });
      const r = await x.run(["sh", "-c", "cat; echo err >&2; exit 3"], { stdin: "in" });
      expect(r).toEqual({ code: 3, stdout: "in", stderr: "err\n" });
      await x.symlink("/target", join(dir, "l"));
      expect(await x.readlink(join(dir, "l"))).toBe("/target");
      const [, notEmpty] = await Promise.all([x.mkdirp(join(dir, "p/q")), x.rmdir(join(dir, "a"))]);
      expect(notEmpty).toBe(false);
      expect((await x.lstat(join(dir, "p/q")))?.type).toBe("dir");
      const e = await x.rename(join(dir, "missing"), join(dir, "x")).catch((e) => e);
      expect(e.code).toBe("ENOENT");
    } finally {
      await x.close();
    }
  });
});

describe("snapshots", () => {
  test("auto uses snapper on btrfs and pairs pre/post", async () => {
    const env = makeEnv();
    const x = new FakeExecutor({ privileged: true }).on((argv) => (argv[0] === "snapper" && argv.includes("pre") ? ok("41\n") : undefined));
    const s = await snapshotter("auto", env.facts, x);
    expect(await s!.pre("rig apply")).toBe("snapper:#41");
    await s!.post("rig apply");
    expect(x.calls.at(-1)).toContain("--pre-number");
    expect(x.calls.at(-1)).toContain("41");
  });

  test("auto without snapper or btrfs does nothing; explicit snapper without it is an error", async () => {
    const env = makeEnv();
    const none = new FakeExecutor().on((argv) => (argv[0] === "sh" ? fail("", 1) : undefined));
    expect(await snapshotter("auto", env.facts, none)).toBeNull();
    await expect(snapshotter("snapper", env.facts, none)).rejects.toThrow("snapper");
    expect(await snapshotter("none", env.facts, none)).toBeNull();
    await expect(snapshotter("btrfs", { ...env.facts, rootfs: "ext4" }, none)).rejects.toThrow("btrfs root");
  });
});

test("adopt packages writes undeclared packages as a module", async () => {
  const env = makeEnv();
  for (const n of ["base", "git", "htop", "yay-bin"]) env.pacman.installed.set(n, true);
  env.pacman.foreign.add("yay-bin");
  const a = await planAdoptPackages({ repo: env.repo, host: "zephyr", declared: new Set(["pkg:pacman:git"]), keep: ["base"], x: env.x, date: "2026-10-13" });
  expect(a).toMatchObject({ explicit: 4, declared: 1, kept: 1, repo: ["htop"], aur: ["yay-bin"] });
  expect(a.file).toBe(join(env.repo, "modules/_adopted/zephyr-packages.ts"));
  expect(a.source).toContain(`  pkg([\n    "htop",\n  ]);\n  pkg.aur([\n    "yay-bin",\n  ]);`);
  expect(existsSync(a.file)).toBe(false); // planning only
});
