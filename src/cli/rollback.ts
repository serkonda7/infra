// `rig rollback <n>`: re-apply the config generation n was applied from. The
// recorded commit is checked out into a temporary git worktree and applied
// like any other config; the result is a new generation. Links keep pointing
// into your working copy (a temporary checkout would vanish under them).

import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "../exec/local.ts";
import { StateStore } from "../state/state.ts";
import { runApply, type RunOptions } from "./run.ts";
import type { Session } from "./session.ts";

export interface RollbackOptions {
  n: number;
  host: string;
  /** The working copy of the config repo. */
  repo: string;
  state: StateStore;
  run: RunOptions;
}

const git = (repo: string, args: string[]) => spawn(["git", "-C", repo, ...args], { env: { LC_ALL: "C" } });

export async function rollback(o: RollbackOptions, s: Session): Promise<number> {
  const ids = await o.state.list(o.host);
  if (!ids.includes(o.n))
    throw new Error(`no generation ${o.n} for ${o.host} on this machine (${ids.length ? `rig gen ls ${o.host}` : "remote hosts keep their generations on the host"})`);
  const gen = await o.state.load(o.host, o.n);
  if (!gen.commit) throw new Error(`generation ${o.n} has no recorded commit: the config wasn't in a git repository when it was applied`);
  const commit = gen.commit.replace(/-dirty$/, "");
  if (commit !== gen.commit) s.warn(`generation ${o.n} was applied with uncommitted changes on top of ${commit}; rolling back to ${commit} itself`);

  // The config may live in a subdirectory of its git repository.
  const prefix = await git(o.repo, ["rev-parse", "--show-prefix"]);
  if (prefix.code !== 0) throw new Error(`${o.repo} is not a git repository: ${prefix.stderr.trim()}`);
  const base = mkdtempSync(join(tmpdir(), `rig-rollback-${o.n}-`));
  const tree = join(base, "repo");
  const add = await git(o.repo, ["worktree", "add", "--detach", "--quiet", tree, commit]);
  if (add.code !== 0) {
    rmSync(base, { recursive: true, force: true });
    throw new Error(`can't check out ${commit}: ${add.stderr.trim() || `git exit ${add.code}`}`);
  }
  try {
    const configDir = join(tree, prefix.stdout.trim());
    // npm dependencies of the config aren't in git: share the working copy's.
    if (existsSync(join(o.repo, "node_modules")) && !existsSync(join(configDir, "node_modules"))) symlinkSync(join(o.repo, "node_modules"), join(configDir, "node_modules"));
    s.info(`rolling back ${o.host} to generation ${o.n} · commit ${commit}`);
    return await runApply({ ...o.run, engine: { ...o.run.engine, host: o.host, configDir, liveRepo: o.repo }, commit, rollbackOf: o.n }, s);
  } finally {
    await git(o.repo, ["worktree", "remove", "--force", tree]);
    rmSync(base, { recursive: true, force: true });
  }
}
