import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateIdentity, identityToRecipient } from "age-encryption";
import { module } from "../src/config/define.ts";
import { tmpl } from "../src/config/context.ts";
import { decrypt, encrypt, parseIdentities, parseRecipients } from "../src/secrets/age.ts";
import { Secret, isSecret, revealText } from "../src/secrets/secret.ts";
import { SecretStore } from "../src/secrets/store.ts";
import { makeEnv } from "./harness.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

// An unencrypted ssh-ed25519 key (generated for these tests only) and its public half.
const SSH_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACBT4cD4fNbGCHTQ5vT5zzd6B7LZxAxv0Xo0ocCuooGGjgAAAJCse/35rHv9
+QAAAAtzc2gtZWQyNTUxOQAAACBT4cD4fNbGCHTQ5vT5zzd6B7LZxAxv0Xo0ocCuooGGjg
AAAEAVd9vpDqhZ/j53ML6RFko/Y55sWf8I6DaK3sQ7Br9ckVPhwPh81sYIdNDm9PnPN3oH
stnEDG/RejShwK6igYaOAAAACHJpZy10ZXN0AQIDBAU=
-----END OPENSSH PRIVATE KEY-----
`;
const SSH_PUB = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFPhwPh81sYIdNDm9PnPN3oHstnEDG/RejShwK6igYaO rig-test";

// Encrypted with the reference age CLI (`age -R key.pub -a`) to SSH_PUB: checks interoperability.
const FROM_AGE_CLI = `-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IHNzaC1lZDI1NTE5IDFjdFR6dyBCcXdI
Y2MyRVZHTm8xLzdtbW5HT3RINjJhaE1FOWZwaWhMaTZ1UUpWVDNBCk0xV3UyS2hn
ZkNZVTZqajhMaEE2M09oZExuRVhRSGRlKzVZcGRrbGZEaUEKLS0tIFl1U3NsYkRP
OHc3Y1Q3OU44emF5WlM2UUxhcGJQQ3NKVEhOY0FFNWw1SEEK9y3TCBiAJT9bRKkC
/aA6M5MiCv0A+ETCZ+27LZ4Y4rxUcQ9lm93gp1JCkaqpbQ==
-----END AGE ENCRYPTED FILE-----
`;

describe("age", () => {
  test("ssh-ed25519 round trip, and decrypting a file from the reference age CLI", async () => {
    const ids = parseIdentities(SSH_KEY, "test");
    expect(await ids[0]!.recipient).toBe(SSH_PUB.split(" ").slice(0, 2).join(" "));
    const armored = await encrypt(enc.encode("hello\n"), parseRecipients(`# me\n${SSH_PUB}\n`));
    expect(armored).toStartWith("-----BEGIN AGE ENCRYPTED FILE-----");
    expect(dec.decode(await decrypt(enc.encode(armored), ids.map((i) => i.identity)))).toBe("hello\n");
    expect(dec.decode(await decrypt(enc.encode(FROM_AGE_CLI), ids.map((i) => i.identity)))).toBe("from-real-age\n");
  });

  test("native age keys, several recipients, wrong key fails", async () => {
    const a = await generateIdentity(), b = await generateIdentity();
    const ct = enc.encode(await encrypt(enc.encode("x"), [await identityToRecipient(a), ...parseRecipients(SSH_PUB)]));
    expect(dec.decode(await decrypt(ct, parseIdentities(`# key\n${a}\n`, "a").map((i) => i.identity)))).toBe("x");
    expect(dec.decode(await decrypt(ct, parseIdentities(SSH_KEY, "ssh").map((i) => i.identity)))).toBe("x");
    await expect(decrypt(ct, [b])).rejects.toThrow();
  });

  test("unsupported keys are rejected clearly", () => {
    expect(() => parseRecipients("ssh-rsa AAAAB3Nza")).toThrow("unsupported recipient");
    const encrypted = SSH_KEY.replace("b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ", "b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHI");
    expect(() => parseIdentities(encrypted, "k")).toThrow();
  });
});

describe("Secret values", () => {
  test("refuse to become strings; tmpl propagates them", () => {
    const s = new Secret("db", enc.encode("hunter2"));
    expect(() => String(s)).toThrow('secret "db" can\'t be converted to a string');
    expect(() => `${s}`).toThrow();
    expect(JSON.stringify({ s })).toBe('{"s":"[secret db]"}');
    const t = tmpl`
      user = app
      pass = ${s}
    `;
    expect(isSecret(t)).toBe(true);
    expect(revealText(t as Secret)).toBe("user = app\npass = hunter2\n");
    expect(typeof tmpl`plain ${1}`).toBe("string");
  });

  test("secret files default to 0600 and their diffs are redacted", async () => {
    const env = makeEnv();
    let value = "TOKEN=one\n";
    const secrets = (n: string) => (n === "api.env" ? enc.encode(value) : (() => { throw new Error(`no ${n}`); })());
    const m = module("m", ({ file, secret, tmpl }) => {
      file("~/api.env", secret("api.env"));
      file("~/app.conf", tmpl`url = https://x\n${secret("api.env")}`, { mode: 0o640 });
    });
    const r = await env.apply([m], { secrets });
    expect(r.failed).toBe(0);
    expect(readFileSync(join(env.home, "api.env"), "utf8")).toBe("TOKEN=one\n");
    expect(statSync(join(env.home, "api.env")).mode & 0o777).toBe(0o600);
    expect(statSync(join(env.home, "app.conf")).mode & 0o777).toBe(0o640);

    value = "TOKEN=two\n";
    const p = await env.plan([m], { secrets });
    const item = p.items.find((i) => i.id === `file:${join(env.home, "api.env")}`)!;
    expect(item.op === "change" && item.note).toBe("content changed, secret");
    expect(item.op === "change" && item.detail).toBeUndefined();

    // The first evaluation pass (before decrypting) only records what is needed.
    const g = env.evalHost([m]);
    expect([...g.secrets]).toEqual(["api.env"]);
    expect(env.evalHost([module("m", ({ secret }) => void secret("../etc/shadow"))]).errors[0]).toContain("invalid secret name");
  });
});

describe("SecretStore", () => {
  test("first encrypt starts secrets/recipients from your key; rekey picks up new recipients", async () => {
    const root = mkdtempSync(join(tmpdir(), "rig-secrets-"));
    const home = join(root, "home"), repo = join(root, "repo");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(repo);
    writeFileSync(join(home, ".ssh/id_ed25519"), SSH_KEY, { mode: 0o600 });
    const prev = process.env.RIG_IDENTITY;
    delete process.env.RIG_IDENTITY;
    try {
      const store = new SecretStore(repo, home);
      await store.encrypt("caddy/env", enc.encode("A=1\n"));
      expect(readFileSync(join(repo, "secrets/recipients"), "utf8")).toContain(SSH_PUB.split(" ").slice(0, 2).join(" "));
      expect(await store.list()).toEqual(["caddy/env"]);
      expect(dec.decode(await store.decrypt("caddy/env"))).toBe("A=1\n");

      // A host key joins: after rekey, it can decrypt too.
      const hostKey = await generateIdentity();
      writeFileSync(join(repo, "secrets/recipients"), readFileSync(join(repo, "secrets/recipients"), "utf8") + (await identityToRecipient(hostKey)) + "\n");
      expect(await store.rekey()).toEqual(["caddy/env"]);
      expect(dec.decode(await decrypt(readFileSync(join(repo, "secrets/caddy/env.age")), [hostKey]))).toBe("A=1\n");

      await expect(store.decrypt("missing")).rejects.toThrow('secret "missing" not found');
      await expect(new SecretStore(repo, join(root, "nobody")).decrypt("caddy/env")).rejects.toThrow("no identity");
    } finally {
      if (prev !== undefined) process.env.RIG_IDENTITY = prev;
    }
  });
});
