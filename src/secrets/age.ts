// age encryption via the pure-TS age-encryption package, plus the
// ssh-ed25519 recipient type (age-encryption.org/v1/ssh-ed25519) that it
// doesn't ship, so SSH keys work as in agenix: your key decrypts, and each
// host's SSH host key can be a recipient too.

import { Decrypter, Encrypter, Stanza, armor, identityToRecipient, type Identity, type Recipient } from "age-encryption";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const LABEL = enc.encode("age-encryption.org/v1/ssh-ed25519");
const ZERO_NONCE = new Uint8Array(12);

const b64 = (d: Uint8Array) => Buffer.from(d).toString("base64").replace(/=+$/, "");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a), out.set(b, a.length);
  return out;
};

/** Reader for the SSH wire format (RFC 4251 strings and uint32s). */
class Wire {
  private off = 0;
  constructor(private buf: Uint8Array) {}
  u32() {
    if (this.off + 4 > this.buf.length) throw new Error("truncated SSH key");
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.off, 4).getUint32(0);
    this.off += 4;
    return v;
  }
  bytes() {
    const n = this.u32();
    if (this.off + n > this.buf.length) throw new Error("truncated SSH key");
    const v = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return v;
  }
  str() {
    return dec.decode(this.bytes());
  }
}

/** The 4-byte recipient hint in ssh-ed25519 stanzas: SHA-256 of the public key blob. */
const sshTag = (blob: Uint8Array) => b64(sha256(blob).subarray(0, 4));

/** Per-key scalar mixed into the shared secret, so the stanza binds to the exact SSH key. */
const sshTweak = (blob: Uint8Array) => hkdf(sha256, new Uint8Array(0), blob, LABEL, 32);

function parseSshEd25519Blob(blob: Uint8Array): Uint8Array {
  const w = new Wire(blob);
  const type = w.str();
  if (type !== "ssh-ed25519") throw new Error(`unsupported SSH key type ${type} (only ssh-ed25519)`);
  const pk = w.bytes();
  if (pk.length !== 32) throw new Error("malformed ssh-ed25519 public key");
  return new Uint8Array(pk);
}

export class SshEd25519Recipient implements Recipient {
  private readonly blob: Uint8Array;
  private readonly xpk: Uint8Array;

  /** `line` is an authorized_keys-style line: `ssh-ed25519 AAAA… [comment]`. */
  constructor(readonly line: string) {
    const [type, data] = line.trim().split(/\s+/);
    if (type !== "ssh-ed25519" || !data) throw new Error(`not an ssh-ed25519 public key: ${line.slice(0, 40)}`);
    this.blob = unb64(data);
    this.xpk = ed25519.utils.toMontgomery(parseSshEd25519Blob(this.blob));
  }

  wrapFileKey(fileKey: Uint8Array): Stanza[] {
    const eph = x25519.utils.randomSecretKey();
    const share = x25519.getPublicKey(eph);
    const shared = x25519.getSharedSecret(sshTweak(this.blob), x25519.getSharedSecret(eph, this.xpk));
    const key = hkdf(sha256, shared, concat(share, this.xpk), LABEL, 32);
    return [new Stanza(["ssh-ed25519", sshTag(this.blob), b64(share)], chacha20poly1305(key, ZERO_NONCE).encrypt(fileKey))];
  }
}

export class SshEd25519Identity implements Identity {
  private readonly xsk: Uint8Array;
  private readonly xpk: Uint8Array;
  private readonly tag: string;
  /** The matching public key line, for recipients files. */
  readonly publicKey: string;

  constructor(private readonly blob: Uint8Array, seed: Uint8Array) {
    const pk = parseSshEd25519Blob(blob);
    // Same conversion as age/agessh: the X25519 scalar is the first half of SHA-512(seed).
    this.xsk = sha512(seed).subarray(0, 32);
    this.xpk = ed25519.utils.toMontgomery(pk);
    this.tag = sshTag(blob);
    this.publicKey = `ssh-ed25519 ${Buffer.from(blob).toString("base64")}`;
  }

  unwrapFileKey(stanzas: Stanza[]): Uint8Array | null {
    for (const s of stanzas) {
      if (s.args[0] !== "ssh-ed25519" || s.args[1] !== this.tag) continue;
      if (s.args.length !== 3 || s.body.length !== 32) throw new Error("invalid ssh-ed25519 stanza");
      const share = unb64(s.args[2]!);
      if (share.length !== 32) throw new Error("invalid ssh-ed25519 stanza");
      const shared = x25519.getSharedSecret(sshTweak(this.blob), x25519.getSharedSecret(this.xsk, share));
      const key = hkdf(sha256, shared, concat(share, this.xpk), LABEL, 32);
      try {
        return chacha20poly1305(key, ZERO_NONCE).decrypt(s.body);
      } catch {
        // A 4-byte tag can collide; another identity may still match.
      }
    }
    return null;
  }
}

/** Parse an unencrypted OpenSSH private key file (`-----BEGIN OPENSSH PRIVATE KEY-----`). */
export function parseOpenSshPrivateKey(pem: string): SshEd25519Identity {
  const m = pem.match(/-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/);
  if (!m) throw new Error("not an OpenSSH private key");
  const raw = unb64(m[1]!.replace(/\s+/g, ""));
  const magic = "openssh-key-v1\0";
  if (dec.decode(raw.subarray(0, magic.length)) !== magic) throw new Error("not an OpenSSH private key");
  const w = new Wire(raw.subarray(magic.length));
  const cipher = w.str();
  w.str(), w.bytes(); // kdf name + options
  if (cipher !== "none") throw new Error("the SSH key is passphrase-protected");
  if (w.u32() !== 1) throw new Error("SSH key files with several keys are not supported");
  const blob = new Uint8Array(w.bytes());
  const priv = new Wire(w.bytes());
  if (priv.u32() !== priv.u32()) throw new Error("corrupt OpenSSH private key");
  const type = priv.str();
  if (type !== "ssh-ed25519") throw new Error(`unsupported SSH key type ${type} (only ssh-ed25519)`);
  priv.bytes(); // public key again
  const sk = priv.bytes(); // seed ‖ public key
  if (sk.length !== 64) throw new Error("malformed ssh-ed25519 private key");
  return new SshEd25519Identity(blob, new Uint8Array(sk.subarray(0, 32)));
}

// ---------------------------------------------------------------------------
// Identities and recipients as they appear in files

export interface LoadedIdentity {
  identity: string | Identity;
  /** Recipient form, for writing a recipients file. */
  recipient: Promise<string>;
  source: string;
}

/**
 * Identities in a file: age secret keys (`AGE-SECRET-KEY-1…`, one per line) or
 * an unencrypted OpenSSH ed25519 private key.
 */
export function parseIdentities(text: string, source: string): LoadedIdentity[] {
  if (text.includes("BEGIN OPENSSH PRIVATE KEY")) {
    const id = parseOpenSshPrivateKey(text);
    return [{ identity: id, recipient: Promise.resolve(id.publicKey), source }];
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("AGE-SECRET-KEY-"))
    .map((k) => ({ identity: k, recipient: identityToRecipient(k), source }));
}

/** One recipient per line (`age1…` or `ssh-ed25519 …`); `#` comments and blank lines are ignored. */
export function parseRecipients(text: string): (string | Recipient)[] {
  return text
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .map((l) => {
      if (l.startsWith("age1")) return l;
      if (l.startsWith("ssh-ed25519 ")) return new SshEd25519Recipient(l);
      throw new Error(`unsupported recipient: ${l.slice(0, 40)}… (use age1… or ssh-ed25519 keys)`);
    });
}

export async function encrypt(data: Uint8Array, recipients: (string | Recipient)[]): Promise<string> {
  if (!recipients.length) throw new Error("no recipients");
  const e = new Encrypter();
  for (const r of recipients) e.addRecipient(r);
  return armor.encode(await e.encrypt(data));
}

export async function decrypt(file: Uint8Array, identities: (string | Identity)[]): Promise<Uint8Array> {
  if (!identities.length) throw new Error("no identities");
  const d = new Decrypter();
  for (const i of identities) d.addIdentity(i);
  const text = dec.decode(file.subarray(0, 64));
  const raw = text.trimStart().startsWith("-----BEGIN AGE ENCRYPTED FILE-----") ? armor.decode(dec.decode(file)) : file;
  return d.decrypt(raw);
}
