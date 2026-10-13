import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { module } from "../src/config/define.ts";
import { parseOsRelease } from "../src/facts/index.ts";
import { aptType } from "../src/resources/apt.ts";
import { makeEnv, mutations, ops } from "./harness.ts";

const APT = "apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold";

test("Debian os-release facts include the codename", () => {
  const os = parseOsRelease('PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nNAME="Debian GNU/Linux"\nVERSION_ID="13"\nVERSION_CODENAME=trixie\nID=debian\n');
  expect(os).toEqual({ family: "debian", id: "debian", idLike: [], name: "Debian GNU/Linux 13 (trixie)", version: "13", codename: "trixie" });
  expect(parseOsRelease("ID=ubuntu\nID_LIKE=debian\nVERSION_CODENAME=noble\n")).toMatchObject({ family: "debian", codename: "noble" });
});

describe("apt", () => {
  test("pkg() on Debian: aliases, batched install, adopt manual, mark manual, prune", async () => {
    const env = makeEnv({ os: "debian" });
    env.apt.installed.set("htop", true); // installed by hand before rig
    env.apt.installed.set("ripgrep", false); // pulled in as a dependency
    const m = module("m", (ctx) => void ctx.pkg(["git", "fd", "htop", "ripgrep", { arch: "base-devel", debian: "build-essential" }]));

    const r = await env.apply([m]);
    expect(ops(r.plan)).toEqual(["create pkg:apt:build-essential", "create pkg:apt:fd-find", "create pkg:apt:git", "update pkg:apt:ripgrep"]);
    expect(mutations(env.system.calls)).toEqual([`${APT} install git fd-find build-essential`, "apt-mark manual ripgrep"]);
    expect(r.failed).toBe(0);

    expect(ops((await env.apply([m])).plan)).toEqual([]);

    env.system.calls.length = 0;
    const gone = await env.apply([]);
    expect(ops(gone.plan)).toEqual([
      "destroy pkg:apt:build-essential",
      "destroy pkg:apt:fd-find",
      "destroy pkg:apt:git",
      "destroy pkg:apt:ripgrep",
      "forget pkg:apt:htop",
    ]);
    expect(mutations(env.system.calls)).toEqual([`${APT} purge build-essential fd-find git`, "apt-mark auto ripgrep", `${APT} autoremove --purge`]);
    expect(env.apt.installed.has("htop")).toBe(true);
    expect(env.apt.installed.get("ripgrep")).toBe(false);
  });

  test("a package still required by others is marked automatic instead", async () => {
    const env = makeEnv({ os: "debian" });
    await env.apply([module("m", (ctx) => void ctx.pkg(["git", "htop"]))]);
    env.apt.required.add("git");
    const r = await env.apply([]);
    expect(r.failed).toBe(0);
    expect(r.events.find((e) => e.item.id === "pkg:apt:git")?.note).toBe("still required; marked automatic");
    expect(env.apt.installed.get("git")).toBe(false);
    expect(env.apt.installed.has("htop")).toBe(false);
  });

  test("install refreshes the package lists once when apt can't find a package", async () => {
    const env = makeEnv({ os: "debian" });
    env.apt.available.delete("caddy");
    env.apt.pending.add("caddy");
    const r = await env.apply([module("m", (ctx) => void ctx.pkg(["caddy"]))]);
    expect(r.failed).toBe(0);
    expect(mutations(env.system.calls)).toEqual([`${APT} install caddy`, `${APT} update`, `${APT} install caddy`]);
  });

  test("pkg.repo writes a deb822 source and keyring, ahead of packages, and updates lists first", async () => {
    const env = makeEnv({ os: "debian" });
    env.apt.available.delete("caddy");
    env.apt.pending.add("caddy");
    const key = "-----BEGIN PGP PUBLIC KEY BLOCK-----\nabc\n-----END PGP PUBLIC KEY BLOCK-----\n";
    const m = module("caddy", (ctx) => {
      ctx.pkg(["caddy"]);
      ctx.pkg.repo("caddy", { uris: "https://dl.cloudsmith.io/public/caddy/stable/deb/debian", suites: "any-version", key });
    });
    const r = await env.apply([m]);
    expect(r.failed).toBe(0);
    const sources = join(env.sys, "etc/apt/sources.list.d/caddy.sources");
    const keyring = join(env.sys, "etc/apt/keyrings/caddy.asc");
    expect(readFileSync(sources, "utf8")).toBe(
      `# Managed by rig.\nTypes: deb\nURIs: https://dl.cloudsmith.io/public/caddy/stable/deb/debian\nSuites: any-version\nComponents: main\nSigned-By: ${keyring}\n`,
    );
    expect(readFileSync(keyring, "utf8")).toBe(key);
    // Lists were refreshed because a source changed, so the first install already finds caddy.
    expect(mutations(env.system.calls)).toEqual([`${APT} update`, `${APT} install caddy`]);
    expect(env.apt.updates).toBe(1);
  });

  test("pkg.repo defaults suites to the release codename", () => {
    const env = makeEnv({ os: "debian" });
    const g = env.evalHost([module("m", (ctx) => void ctx.pkg.repo("x", { uris: "https://example.org/debian" }))]);
    const spec = g.decls.get(`file:${join(env.sys, "etc/apt/sources.list.d/x.sources")}`)!.spec;
    expect(new TextDecoder().decode(spec.data)).toContain("Suites: trixie\n");
    expect(env.evalHost([module("m", (ctx) => void ctx.pkg.aur(["yay-bin"]))]).errors[0]).toContain("AUR packages need an Arch-based host");
  });

  test("exact mode prunes undeclared manual packages, but not the base system or protected ones", async () => {
    const env = makeEnv({ os: "debian" });
    for (const n of ["bash", "apt", "htop", "linux-image-amd64", "openssh-server", "nano"]) env.apt.installed.set(n, true);
    const r = await env.apply([module("m", (ctx) => void ctx.pkg(["htop"]))], { packages: { mode: "exact", keep: ["nan*"] } });
    expect(ops(r.plan)).toEqual([]);
    env.apt.installed.set("cowsay", true);
    const p = await env.plan([module("m", (ctx) => void ctx.pkg(["htop"]))], { packages: { mode: "exact" } });
    expect(ops(p)).toEqual(["destroy pkg:apt:cowsay", "destroy pkg:apt:nano"]);
    expect(env.user.calls.filter((c) => c[0] === "pacman")).toEqual([]);
  });

  test("pkg.removeOrphans removes what apt-get autoremove would", async () => {
    const env = makeEnv({ os: "debian" });
    env.apt.installed.set("htop", true);
    for (const n of ["libfoo1", "libbar2", "linux-image-6.1-amd64"]) env.apt.installed.set(n, false);
    env.apt.needed.add("libbar2");
    const p = await env.plan([module("m", (ctx) => void (ctx.pkg(["htop"]), ctx.pkg.removeOrphans()))]);
    expect(ops(p)).toEqual(["destroy pkg:apt:libfoo1"]);
    expect(env.user.calls.filter((c) => c[0] === "pacman")).toEqual([]);
  });

  test("validation: unknown names fail, empty package lists and pending sources skip the check", async () => {
    const env = makeEnv({ os: "debian" });
    const ctx = (ids: string[] = []) => ({ facts: env.facts, x: env.x, ids: new Set(ids) });
    expect(await aptType.validate!([{ name: "nope" }, { name: "git" }], ctx())).toEqual([
      "pkg:apt:nope: not found in the package lists (try `apt-get update`, or check the Debian name — e.g. fd is fd-find)",
    ]);
    expect(await aptType.validate!([{ name: "nope" }], ctx([`file:${join(env.sys, "etc/apt/sources.list.d/new.sources")}`]))).toEqual([]);
    env.apt.available.clear();
    expect(await aptType.validate!([{ name: "nope" }], ctx())).toEqual([]);
  });

  test("kernelParams on Debian GRUB regenerate with update-grub", () => {
    const env = makeEnv({ os: "debian" });
    const g = env.evalHost([module("m", (ctx) => void ctx.kernelParams(["quiet"]))]);
    const trigger = [...g.decls.values()].find((d) => d.type.kind === "trigger")!;
    expect(trigger.spec.cmd).toBe("update-grub");
  });
});
