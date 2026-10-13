import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { module } from "../src/config/define.ts";
import { spawn } from "../src/exec/local.ts";
import { parseKconfig } from "../src/resources/kconfig.ts";
import { makeEnv, mutations, ops } from "./harness.ts";

describe("flatpak", () => {
  test("installs from flathub after the flatpak package, adopts existing apps, prunes only its own", async () => {
    const env = makeEnv();
    env.pacman.repo.add("flatpak");
    env.flatpak.remotes.add("flathub");
    env.flatpak.installed.set("org.kde.krita", "flathub"); // there before rig
    const m = module("apps", ({ pkg }) => void pkg.flatpak(["org.mozilla.firefox", "com.valvesoftware.Steam", "org.kde.krita"]));
    const r = await env.apply([m]);
    expect(r.failed).toBe(0);
    expect(ops(r.plan)).toEqual(["create pkg:flatpak:com.valvesoftware.Steam", "create pkg:flatpak:org.mozilla.firefox", "create pkg:pacman:flatpak"]);
    const calls = mutations(env.system.calls);
    expect(calls.indexOf("pacman -S --needed --noconfirm flatpak")).toBeLessThan(calls.findIndex((c) => c.startsWith("flatpak install")));
    expect(calls).toContain("flatpak install --system -y --noninteractive flathub org.mozilla.firefox com.valvesoftware.Steam"); // one transaction
    expect(ops(await env.plan([m]))).toEqual([]);

    const gone = await env.apply([]);
    expect(ops(gone.plan)).toEqual(["destroy pkg:flatpak:com.valvesoftware.Steam", "destroy pkg:flatpak:org.mozilla.firefox", "destroy pkg:pacman:flatpak", "forget pkg:flatpak:org.kde.krita"]);
    expect([...env.flatpak.installed.keys()]).toEqual(["org.kde.krita"]);
    expect(mutations(env.system.calls)).toContain("flatpak uninstall --system -y --noninteractive --unused");
  });

  test("adds a missing remote first; rejects names that aren't app IDs", async () => {
    const env = makeEnv();
    env.pacman.repo.add("flatpak");
    await env.apply([module("m", ({ pkg }) => void pkg.flatpak("org.mozilla.firefox"))]);
    expect(mutations(env.system.calls)).toContain("flatpak remote-add --system --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo");
    expect(env.flatpak.installed.get("org.mozilla.firefox")).toBe("flathub");

    const g = env.evalHost([module("m", ({ pkg }) => void pkg.flatpak("firefox"))]);
    expect(g.errors[0]).toContain('reverse-DNS names like org.mozilla.firefox, not "firefox"');
  });
});

describe("kconfig", () => {
  test("parses groups, nested groups, flags, locales and escapes", () => {
    const keys = parseKconfig("[General]\nColorScheme=BreezeDark\nName[de]=X\nName=Y\n\n[A][B]\nk[$i]= a\\sb\\\\n \n[General]\nColorScheme=Later\n");
    expect(keys.get("General\0\0ColorScheme")).toBe("Later");
    expect(keys.get("General\0\0Name")).toBe("Y");
    expect(keys.get("A\0B\0\0k")).toBe("a b\\n");
  });

  test("sets individual keys, leaves the rest of the file alone, restores previous values", async () => {
    const env = makeEnv();
    const kwinrc = join(env.home, ".config/kwinrc");
    mkdirSync(join(env.home, ".config"), { recursive: true });
    writeFileSync(kwinrc, "[Plugins]\nblurEnabled=true\nshakecursorEnabled=true\n\n[Windows]\nPlacement=Smart\n");
    const m = module("kde", ({ kconfig }) =>
      void kconfig("kwinrc", {
        Plugins: { blurEnabled: false },
        "Effect-overview][Shortcuts": { Toggle: "Meta+W" },
      }),
    );
    const p = await env.plan([m]);
    expect(p.items.map((i) => `${i.op === "change" ? i.action : i.op} ${i.display} ${"note" in i ? i.note : ""}`)).toEqual([
      'update kwinrc [Plugins] blurEnabled "true" → "false"',
      'create kwinrc [Effect-overview][Shortcuts] Toggle unset → "Meta+W"',
    ]);
    const r = await env.apply([m]);
    expect(r.failed).toBe(0);
    expect(mutations(env.user.calls)).toContain(`kwriteconfig6 --file ${kwinrc} --group Plugins --key blurEnabled --notify --type bool -- false`);
    const text = readFileSync(kwinrc, "utf8");
    expect(text).toContain("blurEnabled=false\nshakecursorEnabled=true");
    expect(text).toContain("[Effect-overview][Shortcuts]\nToggle=Meta+W");
    expect(text).toContain("Placement=Smart");
    expect(ops(await env.plan([m]))).toEqual([]);

    // Plasma changed one key itself: that one is left alone, the other is restored.
    writeFileSync(kwinrc, readFileSync(kwinrc, "utf8").replace("Toggle=Meta+W", "Toggle=Meta+Tab"));
    const gone = await env.apply([]);
    expect(gone.plan.items.map((i) => `${i.op} ${"note" in i ? i.note : ""}`).sort()).toEqual(['destroy restore "true"', "forget changed since rig set it; left alone"]);
    expect(readFileSync(kwinrc, "utf8")).toContain("blurEnabled=true\n");
    expect(readFileSync(kwinrc, "utf8")).toContain("Toggle=Meta+Tab");
  });

  test("a key that didn't exist is deleted again; a fully managed file can't also be edited", async () => {
    const env = makeEnv();
    await env.apply([module("kde", ({ kconfig }) => void kconfig("~/.config/kdeglobals", { KDE: { SingleClick: false } }))]);
    expect(readFileSync(join(env.home, ".config/kdeglobals"), "utf8")).toContain("SingleClick=false");
    await env.apply([]);
    expect(readFileSync(join(env.home, ".config/kdeglobals"), "utf8")).not.toContain("SingleClick");

    const g = env.evalHost([
      module("m", ({ kconfig, file }) => {
        file("~/.config/kdeglobals", "x");
        kconfig("kdeglobals", { KDE: { SingleClick: false } });
      }),
    ]);
    g.finalize();
    expect(g.errors.join("\n")).toContain("which is fully managed as file:");
  });
});

/** Real git, against throwaway repositories. */
async function gitEnv() {
  const env = makeEnv();
  const realGit = (argv: string[], o?: { cwd?: string; env?: Record<string, string> }) => (["git", "rm", "ls"].includes(argv[0]!) ? spawn(argv, o) : undefined);
  env.user.handlers.unshift(realGit);
  env.system.handlers.unshift(realGit);
  const origin = join(env.root, "origin");
  const sh = async (cmd: string, cwd: string) => {
    const r = await spawn(["sh", "-c", cmd], { cwd, env: { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if (r.code !== 0) throw new Error(`${cmd}: ${r.stderr}`);
    return r.stdout.trim();
  };
  mkdirSync(origin);
  await sh("git init -q -b main && echo 1 > f && git add f && git commit -qm one && git tag v1 && echo 2 > f && git commit -qam two && git tag v2", origin);
  return { env, origin, sh };
}

describe("git", () => {
  test("clones, checks out a pinned tag, moves to a new tag without pulling the branch", async () => {
    const { env, origin, sh } = await gitEnv();
    const path = join(env.home, "src/thing");
    const m = (ref?: string) => module("dev", ({ git }) => void git("~/src/thing", origin, { ref }));

    const r = await env.apply([m("v1")]);
    expect(r.failed).toBe(0);
    expect(readFileSync(join(path, "f"), "utf8")).toBe("1\n");
    expect(ops(await env.plan([m("v1")]))).toEqual([]);

    const bump = await env.plan([m("v2")]);
    expect(bump.items[0]!.op === "change" && bump.items[0]!.note).toMatch(/^[0-9a-f]{7} → v2$/);
    await env.apply([m("v2")]);
    expect(readFileSync(join(path, "f"), "utf8")).toBe("2\n");

    // A branch counts as checked out once it's current; new upstream commits are not pulled.
    await env.apply([m("main")]);
    await sh("echo 3 > f && git commit -qam three", origin);
    expect(ops(await env.plan([m("main")]))).toEqual([]);
    expect(await sh("git rev-parse --abbrev-ref HEAD", path)).toBe("main");
  });

  test("refuses to switch over local changes, or to adopt a checkout of another remote", async () => {
    const { env, origin } = await gitEnv();
    const path = join(env.home, "src/thing");
    await env.apply([module("dev", ({ git }) => void git("~/src/thing", origin, { ref: "v1" }))]);
    writeFileSync(join(path, "f"), "local edit\n");
    const p = await env.plan([module("dev", ({ git }) => void git("~/src/thing", origin, { ref: "v2" }))]);
    expect(p.items[0]!.op === "blocked" && p.items[0]!.reason).toContain("has local changes");

    const other = await env.plan([module("dev", ({ git }) => void git("~/src/thing", "https://example.com/other.git"))]);
    expect(other.items[0]!.op === "blocked" && other.items[0]!.reason).toBe(`origin is ${origin}, not https://example.com/other.git`);
  });

  test("clones are kept when undeclared, unless prune: true and nothing would be lost", async () => {
    const { env, origin } = await gitEnv();
    const path = join(env.home, "src/thing");
    await env.apply([module("dev", ({ git }) => void git("~/src/thing", origin))]);
    const kept = await env.apply([]);
    expect(ops(kept.plan)).toEqual([`forget git:${path}`]);
    expect(existsSync(path)).toBe(true);

    const env2 = (await gitEnv()).env;
    const p2 = join(env2.home, "src/thing");
    const pruned = module("dev", ({ git }) => void git("~/src/thing", origin, { prune: true }));
    await env2.apply([pruned]);
    writeFileSync(join(p2, "untracked"), "x");
    expect(ops((await env2.apply([])).plan)).toEqual([`blocked git:${p2}`]);
    expect(existsSync(p2)).toBe(true);
    await env2.apply([], { force: true });
    expect(existsSync(p2)).toBe(false);
  });
});
