// Messages between the local CLI (controller) and `rig … --bundle - --events ndjson`
// on the target, one JSON object per line over the SSH channel's stdin/stdout.

import type { EventView, PlanView } from "../plan/format.ts";

/** Everything the target needs to evaluate the host: config, the repo files it reads, and decrypted secrets. */
export interface Bundle {
  version: 1;
  host: string;
  /** Git commit of the controller's repo, recorded in the generation. */
  commit: string | null;
  /** The config bundled into one ES module (`rig` stays external), with an inline source map. */
  config: string;
  /** gzipped tar of the repo files evaluation reads, base64. */
  assets: string;
  /** Secret plaintexts by name, base64. Kept in memory on the target; only written as their final files. */
  secrets: Record<string, string>;
}

export interface DoneView {
  generation: number;
  status: "ok" | "partial";
  /** A new generation was recorded. */
  dirty: boolean;
  failed: number;
  actionable: boolean;
  events: EventView[];
}

/** controller → target */
export type ToTarget =
  | { type: "bundle"; bundle: Bundle }
  | { type: "confirm"; ok: boolean }
  | { type: "sudo"; password: string | null }
  | { type: "verify"; ok: boolean };

/** target → controller */
export type FromTarget =
  | { type: "plan"; plan: PlanView }
  | { type: "confirm"; question: string }
  | { type: "sudo"; attempt: number }
  | { type: "info"; message: string }
  | { type: "warn"; message: string }
  | { type: "event"; event: EventView }
  | { type: "verify" }
  | { type: "done"; done: DoneView }
  | { type: "error"; message: string; problems?: string[] };

/** Reads NDJSON messages from a byte stream, in order. */
export class Inbox<T> {
  private queue: T[] = [];
  private waiting: ((m: T | null) => void)[] = [];
  private ended = false;

  constructor(stream: ReadableStream<Uint8Array>, private onBadLine?: (line: string) => void) {
    this.pump(stream);
  }

  private async pump(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder();
    let buf = "";
    const deliver = (line: string) => {
      if (!line.trim()) return;
      let msg: T;
      try {
        msg = JSON.parse(line);
      } catch {
        this.onBadLine?.(line);
        return;
      }
      const w = this.waiting.shift();
      if (w) w(msg);
      else this.queue.push(msg);
    };
    try {
      for await (const chunk of stream) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          deliver(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      deliver(buf);
    } finally {
      this.ended = true;
      for (const w of this.waiting.splice(0)) w(null);
    }
  }

  /** The next message, or null once the stream has ended. */
  next(): Promise<T | null> {
    const m = this.queue.shift();
    if (m !== undefined) return Promise.resolve(m);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** The next message, which must be of `type`. */
  async expect<K extends T extends { type: infer U } ? U : never>(type: K): Promise<Extract<T, { type: K }>> {
    const m = await this.next();
    if (!m) throw new Error(`connection closed while waiting for "${String(type)}"`);
    if ((m as { type?: unknown }).type !== type) throw new Error(`protocol error: expected "${String(type)}", got "${String((m as { type?: unknown }).type)}"`);
    return m as Extract<T, { type: K }>;
  }
}
