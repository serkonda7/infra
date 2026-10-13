// An opaque secret value. It can be written to a file or interpolated into
// tmpl, but never turned into a string by accident (logging, plan output).

const DATA = new WeakMap<Secret, Uint8Array>();
const dec = new TextDecoder();

export class Secret {
  constructor(
    /** For error messages only, e.g. "vault.env". */
    readonly name: string,
    data: Uint8Array,
  ) {
    DATA.set(this, data);
  }

  toString(): never {
    throw new Error(`secret "${this.name}" can't be converted to a string; pass it to file() or interpolate it with tmpl`);
  }

  [Symbol.toPrimitive](): never {
    return this.toString();
  }

  toJSON() {
    return `[secret ${this.name}]`;
  }

  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `[secret ${this.name}]`;
  }
}

export const isSecret = (v: unknown): v is Secret => v instanceof Secret;

/** The plaintext. Only rig internals call this, right before writing it to its target. */
export const reveal = (s: Secret): Uint8Array => DATA.get(s)!;

export const revealText = (s: Secret): string => dec.decode(reveal(s));
