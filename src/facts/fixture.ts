// Facts fixtures for `rig plan --offline --facts <file>`: a host's facts plus,
// optionally, the names in its package databases, so CI can evaluate and
// validate a config without the machine.

import type { Executor, Facts } from "../types.ts";
import { lines } from "../resources/util.ts";

export interface PackageIndex {
  backend: "pacman" | "apt";
  /** Everything installable from the sync repos / package lists. */
  names: string[];
  /** pacman package groups. */
  groups?: string[];
  /** Configured pacman repos. */
  repos?: string[];
  /** When the index was taken. */
  at: string;
}

export interface Fixture {
  /** The host's name in rig.config.ts (may differ from facts.hostname). */
  host?: string;
  facts: Facts;
  packages?: PackageIndex;
}

/** The machine's package index, or null without a known package manager. */
export async function packageIndex(facts: Facts, x: Executor): Promise<PackageIndex | null> {
  const at = new Date().toISOString();
  const must = async (argv: string[]) => {
    const r = await x.run(argv, { env: { LC_ALL: "C" } });
    if (r.code !== 0) throw new Error(`${argv.join(" ")} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    return [...new Set(lines(r.stdout))].sort();
  };
  if (facts.os.family === "arch") {
    const [names, groups, repos] = await Promise.all([must(["pacman", "-Slq"]), must(["pacman", "-Sg"]), x.run(["pacman-conf", "--repo-list"])]);
    return { backend: "pacman", names, groups, repos: lines(repos.stdout), at };
  }
  if (facts.os.family === "debian") return { backend: "apt", names: await must(["apt-cache", "pkgnames"]), at };
  return null;
}

/** A fixture file, or plain `rig facts` output. */
export function parseFixture(text: string, source: string): Fixture {
  let v: any;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`${source}: not JSON (${e instanceof Error ? e.message : e})`);
  }
  const fixture: Fixture = v && typeof v === "object" && "facts" in v ? v : { facts: v };
  const f = fixture.facts as Partial<Facts> | undefined;
  if (!f?.hostname || !f.os?.family || !f.user?.home) throw new Error(`${source}: doesn't look like rig facts (create one with \`rig facts --save\`)`);
  return fixture;
}

const offline = (argv: string[]) => ({ code: 127, stdout: "", stderr: `offline: ${argv.join(" ")} is not available` });

/**
 * Stands in for a machine that isn't there. Package-list queries are answered from the fixture,
 * filesystem reads see nothing, and anything that would change something throws.
 */
export class OfflineExecutor implements Executor {
  readonly privileged = false;
  constructor(private index?: PackageIndex) {}

  async run(argv: string[]) {
    const i = this.index;
    const list = (xs: string[] | undefined) => (xs ? { code: 0, stdout: xs.join("\n") + "\n", stderr: "" } : offline(argv));
    const cmd = argv.join(" ");
    if (i?.backend === "pacman" && cmd === "pacman -Slq") return list(i.names);
    if (i?.backend === "pacman" && cmd === "pacman -Sg") return list(i.groups);
    if (i?.backend === "pacman" && cmd === "pacman-conf --repo-list") return list(i.repos);
    if (i?.backend === "apt" && cmd === "apt-cache pkgnames") return list(i.names);
    return offline(argv);
  }

  async readFile() {
    return null;
  }
  async lstat() {
    return null;
  }
  async readlink() {
    return null;
  }
  private refuse(): never {
    throw new Error("offline: nothing can be changed");
  }
  async writeFile() {
    this.refuse();
  }
  async chmod() {
    this.refuse();
  }
  async symlink() {
    this.refuse();
  }
  async mkdirp() {
    this.refuse();
  }
  async rename() {
    this.refuse();
  }
  async unlink() {
    this.refuse();
  }
  async rmdir(): Promise<boolean> {
    this.refuse();
  }
}
