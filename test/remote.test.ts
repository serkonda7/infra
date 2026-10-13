import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { module } from "../src/config/define.ts";
import { DeadMan, isRisky } from "../src/apply/deadman.ts";
import { assetPaths, rebaseSourceMap } from "../src/remote/bundle.ts";
import { Inbox } from "../src/remote/protocol.ts";
import { FakeExecutor, fail, ok } from "../src/exec/fake.ts";
import type { ChangeItem } from "../src/apply/apply.ts";
import { gatherFacts } from "../src/facts/index.ts";
import { makeEnv, mutations } from "./harness.ts";

const enc = new TextEncoder();

test("assetPaths keeps repo files only, without entries inside included dirs", () => {
  expect(assetPaths("/r", ["/r/dotfiles/nvim", "/r/dotfiles/nvim/init.lua", "/r/keys/a.asc", "/home/x/y", "/r"])).toEqual(["dotfiles/nvim", "keys/a.asc"]);
});

test("rebaseSourceMap makes sources repo-relative", () => {
  const map = { version: 3, sources: ["repo/hosts/a.ts"], mappings: "" };
  const code = `x\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}\n`;
  const out = rebaseSourceMap(code, join(process.cwd(), "repo"));
  const b64 = out.match(/base64,(\S+)/)![1]!;
  expect(JSON.parse(Buffer.from(b64, "base64").toString()).sources).toEqual(["hosts/a.ts"]);
});

test("Inbox delivers NDJSON messages in order, across chunk boundaries", async () => {
  const chunks = ['{"type":"a","n":1}\n{"ty', 'pe":"b"}\nnot json\n', '{"type":"c"}'];
  const bad: string[] = [];
  const inbox = new Inbox<{ type: "a"; n: number } | { type: "b" | "c" | "x" }>(new ReadableStream({ start: (c) => (chunks.forEach((x) => c.enqueue(enc.encode(x))), c.close()) }), (l) => bad.push(l));
  expect(await inbox.expect("a")).toEqual({ type: "a", n: 1 });
  expect((await inbox.next())?.type).toBe("b");
  await expect(inbox.expect("x")).rejects.toThrow('expected "x", got "c"');
  expect(await inbox.next()).toBeNull();
  expect(bad).toEqual(["not json"]);
});

describe("dead-man's switch", () => {
  const sshd = (env: ReturnType<typeof makeEnv>) => join(env.sys, "etc/ssh/sshd_config.d/10-rig.conf");

  test("risky changes are recognised", async () => {
    const env = makeEnv();
    env.systemd.add("sshd.service", "enabled", "active");
    const p = await env.plan([
      module("m", (ctx) => {
        ctx.file(sshd(env), "PasswordAuthentication no\n");
        ctx.file(join(env.sys, "etc/motd"), "hi\n");
        ctx.file("~/.ssh/config", "Host *\n");
        ctx.unit("sshd", { started: true, enabled: false });
      }),
    ]);
    const risky = p.items.filter((i): i is ChangeItem => i.op === "change" && isRisky(i)).map((i) => i.id);
    expect(risky).toEqual([`file:${sshd(env)}`, "unit:system:sshd.service"]);
  });

  test("risky changes and their dependents run last, after arming; triggers after that", async () => {
    const env = makeEnv();
    const armed: string[] = [];
    const m = module("m", (ctx) => {
      const conf = ctx.file(sshd(env), "PasswordAuthentication no\n");
      ctx.file(join(env.sys, "etc/after-sshd"), "x\n", { after: [conf] });
      ctx.file(join(env.sys, "etc/motd"), "hi\n");
      ctx.trigger("systemctl reload sshd", { on: [conf] });
    });
    const r = await env.apply([m], {
      guard: {
        risky: isRisky,
        arm: async (items) => {
          // Everything else is done by now; nothing risky is.
          expect(existsSync(join(env.sys, "etc/motd"))).toBe(true);
          expect(existsSync(sshd(env))).toBe(false);
          armed.push(...items.map((i) => i.id.split("/").pop()!));
        },
      },
    });
    expect(r.failed).toBe(0);
    expect(armed).toEqual(["10-rig.conf", "after-sshd"]);
    expect(r.events.map((e) => (e.item.type.kind === "trigger" ? "trigger" : e.item.id.split("/").pop()))).toEqual(["motd", "10-rig.conf", "after-sshd", "trigger"]);
    expect(r.guarded.sort()).toEqual([`file:${join(env.sys, "etc/after-sshd")}`, `file:${sshd(env)}`]);
  });

  test("if arming fails, risky changes are not applied", async () => {
    const env = makeEnv();
    const r = await env.apply([module("m", (ctx) => void ctx.file(sshd(env), "x\n"))], {
      guard: { risky: isRisky, arm: async () => { throw new Error("no systemd-run"); } },
    });
    expect(r.failed).toBe(1);
    expect(r.events[0]!.error).toContain("dead-man's switch could not be armed: no systemd-run");
    expect(existsSync(sshd(env))).toBe(false);
    expect(r.generation.resources[`file:${sshd(env)}`]).toBeUndefined();
  });

  test("arm schedules a revert script that restores files; disarm cancels; fire runs it", async () => {
    const env = makeEnv();
    const base = join(env.root, "deadman");
    const conf = join(env.sys, "etc/ssh/sshd_config");
    const created = join(env.sys, "etc/ssh/sshd_config.d/new.conf");
    mkdirSync(join(env.sys, "etc/ssh"), { recursive: true });
    writeFileSync(conf, "Port 22\n", { mode: 0o600 });
    const m = module("m", (ctx) => {
      ctx.file(conf, "Port 2222\n");
      ctx.file(created, "X\n");
    });
    const items = (await env.plan([m])).items.filter((i): i is ChangeItem => i.op === "change");

    env.system.handlers.unshift((argv) => (argv[0] === "systemctl" && argv[1] === "stop" ? ok() : undefined));
    const dm = new DeadMan(env.system, 90, base);
    await dm.arm(items);
    const run = mutations(env.system.calls).find((c) => c.startsWith("systemd-run"))!;
    expect(run).toMatch(/^systemd-run --unit=rig-deadman-\d+ --on-active=90s --description=rig dead-man's switch \/bin\/sh .*\/revert\.sh$/);
    const script = run.split(" ").at(-1)!;
    expect(statSync(script).mode & 0o777).toBe(0o700);

    // Apply, then run the revert script for real (with systemctl/logger stubbed out).
    await env.apply([m]);
    expect(readFileSync(conf, "utf8")).toBe("Port 2222\n");
    const stubs = mkdtempSync(join(tmpdir(), "rig-stubs-"));
    for (const b of ["systemctl", "logger"]) writeFileSync(join(stubs, b), "#!/bin/sh\nexit 0\n"), chmodSync(join(stubs, b), 0o755);
    const proc = Bun.spawnSync(["/bin/sh", script], { env: { ...process.env, PATH: `${stubs}:${process.env.PATH}` } });
    expect(proc.exitCode).toBe(0);
    expect(readFileSync(conf, "utf8")).toBe("Port 22\n");
    expect(statSync(conf).mode & 0o777).toBe(0o600);
    expect(existsSync(created)).toBe(false);
    expect(existsSync(script)).toBe(false); // the script cleans up after itself

    env.system.calls.length = 0;
    await dm.disarm();
    expect(mutations(env.system.calls)[0]).toMatch(/^systemctl stop -- rig-deadman-\d+\.timer$/);
    expect(dm.isArmed).toBe(false);

    const dm2 = new DeadMan(env.system, 90, base);
    await dm2.arm(items);
    env.system.calls.length = 0;
    await dm2.fire();
    const calls = mutations(env.system.calls);
    expect(calls[0]).toMatch(/^systemctl stop -- rig-deadman-\d+\.timer$/);
    expect(calls[1]).toMatch(/^\/bin\/sh .*\/revert\.sh$/);
  });

  test("arm reports systemd-run failures", async () => {
    const env = makeEnv();
    const x = new FakeExecutor({ privileged: true, handlers: [(argv) => (argv[0] === "systemd-run" ? fail("Failed to start transient timer unit") : undefined)] });
    const items = (await env.plan([module("m", (ctx) => void ctx.file(join(env.sys, "etc/ssh/a"), "x"))])).items as ChangeItem[];
    await expect(new DeadMan(x, 120, join(env.root, "dm")).arm(items)).rejects.toThrow("systemd-run failed: Failed to start transient timer unit");
  });
});

describe("remote apply over a fake ssh", () => {
  test("pushes rig and the bundle, streams the plan, applies, records the generation on the target", async () => {
    const root = mkdtempSync(join(tmpdir(), "rig-remote-"));
    const repo = join(root, "repo"), remoteHome = join(root, "remote"), localHome = join(root, "local");
    for (const d of [join(repo, "hosts"), join(repo, "dotfiles/app"), remoteHome, join(localHome, ".config/rig")]) mkdirSync(d, { recursive: true });
    const ssh = join(root, "ssh");
    writeFileSync(
      ssh,
      `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "--" ] && { shift; break; }; shift; done\nexport HOME=${remoteHome} XDG_STATE_HOME= XDG_DATA_HOME= XDG_CACHE_HOME=\nexec sh -c "$1"\n`,
    );
    chmodSync(ssh, 0o755);
    writeFileSync(join(repo, "rig.config.ts"), `import { defineConfig } from "rig";\nexport default defineConfig({ hosts: { far: () => import("./hosts/far") } });\n`);
    writeFileSync(
      join(repo, "hosts/far.ts"),
      `import { host, module } from "rig";\nconst m = module("m", (ctx) => {\n  ctx.link("~/.config/app", "dotfiles/app");\n  ctx.file("~/token", ctx.secret("token"));\n});\nexport default host({ os: ${JSON.stringify(gatherFacts().os.family)}, connect: { ssh: "me@far" }, modules: [m] });\n`,
    );
    writeFileSync(join(repo, "dotfiles/app/conf"), "a\n");
    writeFileSync(join(repo, "unreferenced"), "not shipped\n");

    const { generateIdentity, identityToRecipient } = await import("age-encryption");
    const id = await generateIdentity();
    writeFileSync(join(localHome, ".config/rig/identity"), id + "\n");
    const { encrypt } = await import("../src/secrets/age.ts");
    mkdirSync(join(repo, "secrets"));
    writeFileSync(join(repo, "secrets/token.age"), await encrypt(enc.encode("s3cret\n"), [await identityToRecipient(id)]));

    const env = { ...process.env, HOME: localHome, RIG_SSH: ssh, XDG_CACHE_HOME: join(tmpdir(), "rig-test-cache"), XDG_CONFIG_HOME: "", RIG_IDENTITY: "", NO_COLOR: "1" };
    const rig = (...args: string[]) => Bun.spawnSync(["bun", join(import.meta.dir, "../src/cli/main.ts"), ...args, "--config", repo], { env, cwd: root });

    const plan = rig("plan", "far");
    expect(plan.stderr.toString()).toBe("");
    expect(plan.exitCode).toBe(2);
    expect(plan.stdout.toString()).toContain("host far ·");
    expect(plan.stdout.toString()).toContain("+ ~/token");

    const apply = rig("apply", "far", "-y");
    expect(apply.exitCode).toBe(0);
    expect(apply.stdout.toString()).toContain("Done · generation 1 recorded");
    expect(readFileSync(join(remoteHome, "token"), "utf8")).toBe("s3cret\n");
    expect(statSync(join(remoteHome, "token")).mode & 0o777).toBe(0o600);
    const bundleDir = join(remoteHome, ".local/share/rig/bundles/far");
    expect(readlinkSync(join(remoteHome, ".config/app"))).toBe(join(bundleDir, "dotfiles/app"));
    expect(existsSync(join(bundleDir, "unreferenced"))).toBe(false);
    expect(existsSync(join(bundleDir, "secrets"))).toBe(false); // secrets travel in-band only
    expect(existsSync(join(remoteHome, ".local/state/rig/hosts/far/generations/1.json"))).toBe(true);

    expect(rig("plan", "far").exitCode).toBe(0);

    const facts = rig("facts", "far");
    expect(JSON.parse(facts.stdout.toString()).user.home).toBe(remoteHome);
  }, 120_000);
});
