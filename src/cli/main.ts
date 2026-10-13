#!/usr/bin/env bun
import { parseArgs } from "node:util";
import * as fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import pkgJson from "../../package.json" with { type: "json" };
import { ConfigError, closeExecutors, evaluateHost, isRemote, loadTarget, prepare, type EngineOptions } from "../engine.ts";
import { streamToStderr } from "../exec/local.ts";
import { formatWhy, why } from "./why.ts";
import { formatStatus, status } from "./status.ts";
import { rollback } from "./rollback.ts";
import { gatherFacts, parseFacts } from "../facts/index.ts";
import { findConfigDir } from "../config/load.ts";
import { StateStore, defaultStateDir } from "../state/state.ts";
import { executeAdopt, planAdopt, planAdoptPackages } from "./adopt.ts";
import { serveHelper } from "../helper/server.ts";
import { NdjsonSession, TerminalSession } from "./session.ts";
import { runApply, runPlan, type RunOptions } from "./run.ts";
import { runRemote } from "../remote/client.ts";
import { BUNDLE_FILE, unpackBundle } from "../remote/bundle.ts";
import { Inbox, type ToTarget } from "../remote/protocol.ts";
import { SecretStore } from "../secrets/store.ts";
import { parseRecipients } from "../secrets/age.ts";
import { c, confirm, err, out } from "./ui.ts";

const HELP = `${c.bold("rig")} ${pkgJson.version} — declarative machine & dotfile management

${c.bold("usage")}
  rig plan [host]            show what apply would change (exit 2 if changes)
  rig apply [host] [-y]      plan, confirm, apply (hosts with connect: are applied over SSH)
  rig dot [-y]               apply home-scoped resources only (no sudo)
  rig adopt <path>           move a file/dir into dotfiles/ and link it back
        [--module <name>]    …and append the link() call to that module
        [--as <repo path>]   …at this repo path instead of dotfiles/<name>
  rig adopt packages         write undeclared explicit packages to modules/_adopted/<host>-packages.ts
        [--host <name>]
  rig why <id|path|name>     which module declared a resource, what it depends on and what needs it
        [host] [--facts <file>]
  rig status [host]          current generation, drift, pending .pacnew/.dpkg-dist files, failed units
  rig facts [host]           print gathered facts as JSON (of a remote host over SSH)
  rig gen ls [host]          list generations
  rig gen gc [--keep <n>]    delete all but the newest n generations per host (default 10) and unused backups
  rig rollback <n> [host]    re-apply the config generation n was applied from (alias: rig gen rollback)
  rig secret ls              list secrets/*.age and their recipients
  rig secret edit <name>     decrypt secrets/<name>.age into $EDITOR, re-encrypt on save
  rig secret rekey           re-encrypt every secret to secrets/recipients

${c.bold("flags")}
  -y, --yes                  don't ask for confirmation
  --only <glob>              restrict to resource IDs or module names matching glob
  --force                    overwrite/remove things rig would otherwise refuse to
  --upgrade                  pacman -Syu before applying
  --demote                   exact mode / pkg.remove: mark undeclared packages as deps instead of removing
  --no-snapshot              skip the btrfs/snapper snapshot around system changes
  --config <dir>             config repo (default: search upwards, $RIG_CONFIG, ~/infra)
  --json                     machine-readable output
  -v, --verbose              show unchanged resources and command output
`;

async function main(argv: string[]): Promise<number> {
  // Privileged side, started by the user process as `sudo rig __helper`. Never loads config.
  if (argv[0] === "__helper") return await serveHelper(), 0;

  const { values: f, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      yes: { type: "boolean", short: "y" },
      only: { type: "string" },
      force: { type: "boolean" },
      upgrade: { type: "boolean" },
      demote: { type: "boolean" },
      "no-snapshot": { type: "boolean" },
      host: { type: "string" },
      config: { type: "string" },
      json: { type: "boolean" },
      verbose: { type: "boolean", short: "v" },
      module: { type: "string" },
      as: { type: "string" },
      bundle: { type: "string" },
      events: { type: "string" },
      facts: { type: "string" },
      keep: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean" },
    },
  });
  const [cmd, ...args] = positionals;
  if (f.version) return out(pkgJson.version), 0;
  if (f.help || !cmd || cmd === "help") return out(HELP), cmd || f.help ? 0 : 1;

  const engine: EngineOptions = { configDir: f.config, force: f.force, only: f.only, demote: f.demote };
  if (f.bundle !== undefined) return bundleCommand(cmd, f);
  if (f.facts !== undefined && cmd !== "why") return err("--facts only works with rig why"), 1;

  switch (cmd) {
    case "plan":
    case "apply":
    case "dot": {
      const userOnly = cmd === "dot";
      const host = userOnly ? undefined : args[0];
      const session = new TerminalSession({ json: f.json, verbose: f.verbose, yes: f.yes, planOnly: cmd === "plan" });
      const run: RunOptions = { engine: { ...engine, host, userOnly, fast: userOnly }, userOnly, upgrade: f.upgrade, noSnapshot: f["no-snapshot"], verbose: f.verbose };
      if (!userOnly) {
        const facts = gatherFacts();
        const target = await loadTarget({ ...run.engine, facts });
        if (isRemote(target)) return runRemote({ cmd: cmd as "plan" | "apply", target, flags: passThrough(f), session });
        run.engine.facts = facts;
      }
      return cmd === "plan" ? runPlan(run, session) : runApply(run, session);
    }

    case "adopt": {
      const target = args[0];
      if (target === "packages") {
        const p = await prepare({ ...engine, host: f.host, fast: true });
        try {
          const a = await planAdoptPackages({
            repo: p.repo,
            host: p.hostName,
            declared: new Set(p.graph.decls.keys()),
            keep: ["base", ...(p.hostDef.packages?.keep ?? [])],
            x: p.x,
          });
          const rel = relative(p.repo, a.file);
          out(`Found ${a.explicit} explicit packages; ${a.declared} already declared, ${a.kept} kept by base/keep.`);
          if (!a.repo.length && !a.aur.length) return out(c.green("Nothing to adopt.")), 0;
          if ((await Bun.file(a.file).exists()) && !f.force) return err(c.red(`${rel} already exists; sort it out first or pass --force to overwrite`)), 1;
          if (!f.yes && !confirm(`Write ${a.repo.length + a.aur.length} entries (${a.aur.length} AUR) to ${rel}?`)) return out("Aborted."), 1;
          await Bun.write(a.file, a.source);
          out(c.green(`Wrote ${rel}`) + ` — add adoptedPackages to the host's modules, sort the entries into modules, then switch to packages: { mode: "exact" }.`);
          return 0;
        } finally {
          await closeExecutors(p.x);
        }
      }
      if (!target) return err("usage: rig adopt <path> [--module <name>] [--as <repo path>] | rig adopt packages [--host <name>]"), 1;
      const facts = gatherFacts();
      const repo = findConfigDir(f.config, facts.user.home);
      const a = await planAdopt({ path: target, repo, home: facts.user.home, as: f.as, module: f.module });
      out(`${c.bold("adopt")} ${target}`);
      out(`  move  → ${relative(repo, a.dest)}`);
      out(`  link  ${target} → ${relative(repo, a.dest)}`);
      if (a.moduleFile) out(`  edit  ${relative(repo, a.moduleFile)}: ${a.snippet}`);
      if (!f.yes && !confirm("Proceed?")) return out("Aborted."), 1;
      await executeAdopt(a);
      out(c.green("Adopted."));
      if (!a.moduleFile) out(`Add this to a module:\n  ${c.cyan(a.snippet)}`);
      return 0;
    }

    case "facts": {
      const facts = gatherFacts();
      if (args[0]) {
        const target = await loadTarget({ ...engine, host: args[0], facts });
        if (isRemote(target)) return runRemote({ cmd: "facts", target, flags: [], session: new TerminalSession({ json: true }) });
      }
      return out(JSON.stringify(facts, null, 2)), 0;
    }

    case "why": {
      const query = args[0];
      if (!query) return err("usage: rig why <id|path|name> [host] [--facts <file>]"), 1;
      const local = gatherFacts();
      let facts = local;
      if (f.facts) facts = parseFacts(await Bun.file(f.facts).text(), f.facts);
      const target = await loadTarget({ ...engine, host: args[1] ?? f.host, facts: local });
      if (!f.facts && isRemote(target)) {
        let text: string | null = null;
        const code = await runRemote({ cmd: "facts", target, flags: [], session: new TerminalSession({ json: true }), output: (t) => (text = t) });
        if (code !== 0 || text === null) return code || 1;
        facts = parseFacts(text, target.hostName);
      }
      // No secrets: what a resource is and where it comes from doesn't depend on their values.
      const graph = evaluateHost(target, facts);
      graph.finalize();
      if (graph.errors.length) throw new ConfigError(graph.errors);
      const prev = isRemote(target) ? null : await new StateStore(defaultStateDir(local.user.home)).latest(target.hostName);
      const r = why(graph, prev, query, { host: target.hostName, home: facts.user.home, repo: target.repo });
      out(f.json ? JSON.stringify(r, null, 2) : formatWhy(r, graph));
      return r.matches.length || r.owned.length ? 0 : 1;
    }

    case "status": {
      const facts = gatherFacts();
      const target = await loadTarget({ ...engine, host: args[0], facts });
      if (isRemote(target)) return err(`rig status reads the machine it runs on; for ${target.hostName}, run it there (or rig plan ${target.hostName})`), 1;
      const s = await status({ ...engine, host: args[0], facts });
      out(f.json ? JSON.stringify(s, null, 2) : formatStatus(s));
      return 0;
    }

    case "rollback":
      return rollbackCommand(args, f, engine);

    case "secret":
      return secretCommand(args, f);

    case "gen": {
      const sub = args[0] ?? "ls";
      if (sub === "rollback") return rollbackCommand(args.slice(1), f, engine);
      const facts = gatherFacts();
      const state = new StateStore(defaultStateDir(facts.user.home));
      if (sub === "gc") {
        const keep = f.keep === undefined ? 10 : Number(f.keep);
        if (!Number.isInteger(keep) || keep < 1) return err("--keep needs a whole number ≥ 1"), 1;
        const r = await state.gc(keep);
        if (f.json) return out(JSON.stringify(r, null, 2)), 0;
        const hosts = [...new Set(r.generations.map((g) => g.host))];
        out(r.generations.length ? `Deleted ${r.generations.length} generation(s) of ${hosts.join(", ")}` : c.dim(`Nothing to delete: no host has more than ${keep} generations.`));
        if (r.objects) out(`Deleted ${r.objects} backup object(s) no remaining generation refers to.`);
        return 0;
      }
      if (sub !== "ls") return err(`rig gen ${sub}: expected ls, gc or rollback`), 1;
      const host = args[1] ?? facts.hostname;
      const ids = await state.list(host);
      if (!ids.length) return out(`no generations for ${host}`), 0;
      const gens = await Promise.all(ids.map((id) => state.load(host, id)));
      if (f.json) return out(JSON.stringify(gens.map(({ resources, ...g }) => ({ ...g, resources: Object.keys(resources).length })), null, 2)), 0;
      for (const g of gens) {
        const cur = g.id === ids.at(-1) ? c.green(" (current)") : "";
        const status = g.status === "ok" ? c.green("ok") : c.yellow(g.status);
        const extra = [g.rollbackOf && `rollback of ${g.rollbackOf}`, g.snapshot].filter(Boolean).join(" · ");
        out(`${String(g.id).padStart(4)}  ${g.at.replace("T", " ").slice(0, 19)}  ${status.padEnd(7)}  ${(g.commit ?? "-").padEnd(14)}  ${Object.keys(g.resources).length} resources${extra ? c.dim(`  ${extra}`) : ""}${cur}`);
      }
      return 0;
    }

    default:
      err(`unknown command: ${cmd}\n`);
      err(HELP);
      return 1;
  }
}

type Flags = Record<string, string | boolean | undefined>;

async function rollbackCommand(args: string[], f: Flags, engine: EngineOptions): Promise<number> {
  const n = Number(args[0]);
  if (!args[0] || !Number.isInteger(n) || n < 1) return err("usage: rig rollback <generation> [host] [-y]"), 1;
  const facts = gatherFacts();
  const repo = findConfigDir(f.config as string | undefined, facts.user.home);
  const session = new TerminalSession({ json: !!f.json, verbose: !!f.verbose, yes: !!f.yes });
  return rollback(
    {
      n,
      host: args[1] ?? facts.hostname,
      repo,
      state: new StateStore(defaultStateDir(facts.user.home)),
      run: { engine: { ...engine, facts }, noSnapshot: !!f["no-snapshot"], verbose: !!f.verbose },
    },
    session,
  );
}

/** Flags a remote run forwards to the rig on the target; -y and --json are handled locally. */
function passThrough(f: Flags): string[] {
  const out: string[] = [];
  for (const k of ["force", "upgrade", "demote", "no-snapshot", "verbose"]) if (f[k]) out.push(`--${k}`);
  if (typeof f.only === "string") out.push("--only", f.only);
  return out;
}

/** Target half of a remote run: config arrives on stdin, events go to stdout as NDJSON. */
async function bundleCommand(cmd: string, f: Flags): Promise<number> {
  if (f.bundle !== "-" || f.events !== "ndjson") return err("--bundle only supports `--bundle - --events ndjson`"), 1;
  if (cmd !== "plan" && cmd !== "apply") return err(`--bundle works with plan and apply, not ${cmd}`), 1;
  // stdout carries the protocol: command output that would be shown goes to stderr instead.
  streamToStderr();
  const inbox = new Inbox<ToTarget>(Bun.stdin.stream());
  const ndjson = (remote.session = new NdjsonSession(inbox));
  const { bundle } = await inbox.expect("bundle");
  const { dir, secrets } = await unpackBundle(bundle);
  const run: RunOptions = {
    engine: {
      configDir: dir,
      configFile: BUNDLE_FILE,
      host: bundle.host,
      onTarget: true,
      force: !!f.force,
      only: f.only as string | undefined,
      demote: !!f.demote,
      secrets: (name) => {
        const v = secrets.get(name);
        if (!v) throw new Error(`secret "${name}" was not sent with the bundle`);
        return v;
      },
    },
    upgrade: !!f.upgrade,
    noSnapshot: !!f["no-snapshot"],
    verbose: !!f.verbose,
    commit: bundle.commit,
    guardConnection: true,
  };
  return cmd === "plan" ? runPlan(run, ndjson) : runApply(run, ndjson);
}

async function secretCommand(args: string[], f: Flags): Promise<number> {
  const [sub, name] = args;
  const home = process.env.HOME || homedir();
  const repo = findConfigDir(f.config as string | undefined, home);
  const store = new SecretStore(repo, home);
  switch (sub ?? "ls") {
    case "ls": {
      const names = await store.list();
      const text = await store.recipientsText();
      const recipients = text === null ? [] : text.split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean);
      if (f.json) return out(JSON.stringify({ secrets: names, recipients }, null, 2)), 0;
      out(c.bold("secrets") + c.dim(` (${relative(repo, store.dir)})`));
      for (const n of names) out(`  ${n}`);
      if (!names.length) out(c.dim("  none — create one with rig secret edit <name>"));
      out();
      out(c.bold("recipients"));
      for (const r of recipients) out(`  ${r.length > 60 ? r.slice(0, 57) + "…" : r}`);
      if (!recipients.length) out(c.dim("  none yet — created from your key by the first rig secret edit"));
      return 0;
    }
    case "edit": {
      if (!name) return err("usage: rig secret edit <name>"), 1;
      const path = store.path(name);
      const exists = await Bun.file(path).exists();
      const before = exists ? await store.decrypt(name) : new Uint8Array();
      // A private directory on tmpfs where possible: the plaintext never hits a persistent disk.
      const base = process.env.XDG_RUNTIME_DIR || "/dev/shm";
      const dir = mkdtempSync(join(await fs.stat(base).then(() => base, () => tmpdir()), "rig-secret-"));
      const file = join(dir, name.replaceAll("/", "_"));
      try {
        await fs.writeFile(file, before, { mode: 0o600 });
        const editor = process.env.VISUAL || process.env.EDITOR || "vi";
        const proc = Bun.spawn(["sh", "-c", `${editor} "$1"`, "sh", file], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
        if ((await proc.exited) !== 0) return err(c.red(`${editor} exited with an error; ${name} unchanged`)), 1;
        const after = new Uint8Array(await fs.readFile(file));
        if (exists && Buffer.from(after).equals(Buffer.from(before))) return out(c.dim(`${name} unchanged`)), 0;
        await store.encrypt(name, after);
        out(c.green(`${exists ? "Updated" : "Created"} ${relative(repo, path)}`));
        return 0;
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
    case "rekey": {
      const text = await store.recipientsText();
      if (text === null) return err(`no ${relative(repo, join(store.dir, "recipients"))} yet; create a secret first`), 1;
      const n = parseRecipients(text).length;
      const names = await store.rekey();
      out(c.green(`Re-encrypted ${names.length} secret${names.length === 1 ? "" : "s"} to ${n} recipient${n === 1 ? "" : "s"}.`));
      return 0;
    }
    default:
      return err(`rig secret ${sub}: expected ls, edit or rekey`), 1;
  }
}

/** Set while running as the target of a remote apply: errors are reported in-band. */
const remote: { session: NdjsonSession | null } = { session: null };

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  if (remote.session) {
    remote.session.send({ type: "error", message: e instanceof Error ? e.message : String(e), ...(e instanceof ConfigError ? { problems: e.problems } : {}) });
  } else if (e instanceof ConfigError) {
    err(c.red(c.bold("configuration error")));
    for (const p of e.problems) err(`  ${c.red("•")} ${p}`);
  } else {
    err(c.red(`error: ${e instanceof Error ? e.message : String(e)}`));
    if (process.env.RIG_DEBUG && e instanceof Error) err(e.stack ?? "");
  }
  process.exitCode = 1;
}
// On the target of a remote run, a pending read on stdin would keep us alive: exit once the events are out.
if (remote.session) {
  await new Promise((resolve) => process.stdout.write("", resolve));
  process.exit();
}
