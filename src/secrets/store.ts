// The repo's secrets/ directory: <name>.age files plus a `recipients` file
// listing who can decrypt them (your SSH/age keys and each host's SSH host key).

import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { Identity } from "age-encryption";
import { decrypt, encrypt, parseIdentities, parseRecipients, type LoadedIdentity } from "./age.ts";
import { errMsg } from "../resources/util.ts";

export const SECRETS_DIR = "secrets";
export const RECIPIENTS_FILE = "recipients";

/** Secret names are paths below secrets/ without the .age suffix, e.g. "vault.env" or "caddy/env". */
export function checkName(name: string) {
  if (!name || name.startsWith("/") || name.split("/").some((p) => p === ".." || p === "." || p === "") || name.endsWith(".age"))
    throw new Error(`invalid secret name "${name}" (a path below secrets/, without .age)`);
}

/** Where we look for keys that can decrypt: $RIG_IDENTITY, ~/.config/rig/identity, ~/.ssh/id_ed25519. */
export function identityPaths(home: string): string[] {
  const xdg = process.env.XDG_CONFIG_HOME || join(home, ".config");
  return [process.env.RIG_IDENTITY, join(xdg, "rig/identity"), join(home, ".ssh/id_ed25519")].filter((p): p is string => !!p);
}

export async function loadIdentities(home: string): Promise<{ identities: LoadedIdentity[]; problems: string[] }> {
  const identities: LoadedIdentity[] = [];
  const problems: string[] = [];
  for (const path of identityPaths(home)) {
    if (!existsSync(path)) continue;
    try {
      identities.push(...parseIdentities(await fs.readFile(path, "utf8"), path));
    } catch (e) {
      problems.push(`${path}: ${errMsg(e)}`);
    }
  }
  return { identities, problems };
}

export class SecretStore {
  readonly dir: string;
  private ids: Promise<{ identities: LoadedIdentity[]; problems: string[] }> | null = null;

  constructor(readonly repo: string, readonly home: string) {
    this.dir = join(repo, SECRETS_DIR);
  }

  path(name: string) {
    checkName(name);
    return join(this.dir, `${name}.age`);
  }

  async list(): Promise<string[]> {
    if (!existsSync(this.dir)) return [];
    const names: string[] = [];
    for await (const f of new Bun.Glob("**/*.age").scan({ cwd: this.dir, onlyFiles: true })) names.push(f.slice(0, -".age".length));
    return names.sort();
  }

  async recipientsText(): Promise<string | null> {
    const p = join(this.dir, RECIPIENTS_FILE);
    return existsSync(p) ? fs.readFile(p, "utf8") : null;
  }

  private identities() {
    return (this.ids ??= loadIdentities(this.home));
  }

  async decrypt(name: string): Promise<Uint8Array> {
    const path = this.path(name);
    if (!existsSync(path)) throw new Error(`secret "${name}" not found (${relative(this.repo, path)})`);
    const { identities, problems } = await this.identities();
    if (!identities.length)
      throw new Error(
        `no identity to decrypt secret "${name}": put an age key in ~/.config/rig/identity or set $RIG_IDENTITY` +
          (problems.length ? ` (${problems.join("; ")})` : ` (looked in ${identityPaths(this.home).join(", ")})`),
      );
    try {
      return await decrypt(new Uint8Array(await fs.readFile(path)), identities.map((i) => i.identity as string | Identity));
    } catch (e) {
      throw new Error(`can't decrypt secret "${name}" with ${identities.map((i) => i.source).join(", ")}: ${errMsg(e)}${problems.length ? ` (${problems.join("; ")})` : ""}`);
    }
  }

  /** Encrypt to everyone in secrets/recipients; creates that file from your own key on first use. */
  async encrypt(name: string, data: Uint8Array): Promise<void> {
    const path = this.path(name);
    let text = await this.recipientsText();
    if (text === null) {
      const { identities } = await this.identities();
      if (!identities.length) throw new Error(`no secrets/${RECIPIENTS_FILE} and no identity to start one from (looked in ${identityPaths(this.home).join(", ")})`);
      text = `# Who can decrypt secrets/*.age: one age1… or ssh-ed25519 key per line.\n# Add each host's /etc/ssh/ssh_host_ed25519_key.pub, then run \`rig secret rekey\`.\n${await identities[0]!.recipient}\n`;
      await fs.mkdir(this.dir, { recursive: true });
      await Bun.write(join(this.dir, RECIPIENTS_FILE), text);
    }
    const armored = await encrypt(data, parseRecipients(text));
    await fs.mkdir(join(path, ".."), { recursive: true });
    await Bun.write(path + ".tmp", armored);
    await fs.rename(path + ".tmp", path);
  }

  /** Re-encrypt every secret to the current recipients. */
  async rekey(): Promise<string[]> {
    const names = await this.list();
    const plain = await Promise.all(names.map((n) => this.decrypt(n)));
    for (const [i, n] of names.entries()) await this.encrypt(n, plain[i]!);
    return names;
  }
}
