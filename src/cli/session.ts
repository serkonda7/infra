// How a plan/apply run talks to its user. Locally that's the terminal; on the
// target of a remote run it's an NDJSON stream to the controller, which
// renders it with the same terminal session — so both look identical.

import { ensureSudo, spawn } from "../exec/local.ts";
import { eventJson, formatEvent, formatPlan, planJson, type EventView, type PlanView } from "../plan/format.ts";
import type { DoneView, FromTarget, Inbox, ToTarget } from "../remote/protocol.ts";
import { c, confirm, err, out } from "./ui.ts";

export interface Session {
  plan(view: PlanView): void;
  /** Ask before changing anything. False means the user declined (already reported). */
  confirm(question: string): Promise<boolean>;
  /** Make sure later sudo calls won't prompt. */
  sudo(): Promise<boolean>;
  info(message: string): void;
  warn(message: string): void;
  event(e: EventView): void;
  done(d: DoneView): void;
  /** Prove that a fresh connection to the host still works (remote runs only). */
  verify?(): Promise<boolean>;
}

export interface TerminalOptions {
  /** Machine-readable output: the plan as JSON for `rig plan`, a final summary for apply. */
  json?: boolean;
  verbose?: boolean;
  yes?: boolean;
  /** This is `rig plan`: print the plan and nothing else. */
  planOnly?: boolean;
}

export class TerminalSession implements Session {
  constructor(readonly opts: TerminalOptions = {}) {}

  plan(view: PlanView) {
    if (this.opts.json) {
      if (this.opts.planOnly) out(JSON.stringify(planJson(view), null, 2));
    } else out(formatPlan(view, { verbose: this.opts.verbose }));
  }

  async confirm(question: string) {
    if (this.opts.yes) return true;
    if (!process.stdin.isTTY) {
      err(c.red("\nnot a terminal; pass -y to apply without confirmation"));
      return false;
    }
    out();
    if (confirm(question)) return true;
    out("Aborted.");
    return false;
  }

  async sudo() {
    if (await ensureSudo()) return true;
    err(c.red("sudo authentication failed"));
    return false;
  }

  info(message: string) {
    if (!this.opts.json) out(c.dim(message));
  }

  warn(message: string) {
    err(c.yellow(`warning: ${message}`));
  }

  event(e: EventView) {
    if (!this.opts.json) out(formatEvent(e));
  }

  done(d: DoneView) {
    if (this.opts.json) {
      out(JSON.stringify({ generation: d.generation, status: d.status, events: d.events.map(eventJson) }, null, 2));
    } else if (d.actionable || d.failed) {
      const tail = d.dirty ? `generation ${d.generation} recorded` : "no new generation";
      out();
      out(d.failed ? c.red(`${d.failed} failed · ${tail} (partial)`) : c.green(`Done · ${tail}`));
    }
  }
}

/** Target side of a remote run: everything goes to the controller as NDJSON on stdout. */
export class NdjsonSession implements Session {
  constructor(private inbox: Inbox<ToTarget>) {}

  send(m: FromTarget) {
    process.stdout.write(JSON.stringify(m) + "\n");
  }

  plan(view: PlanView) {
    this.send({ type: "plan", plan: view });
  }

  async confirm(question: string) {
    this.send({ type: "confirm", question });
    return (await this.inbox.expect("confirm")).ok;
  }

  async sudo() {
    if (process.getuid?.() === 0) return true;
    if ((await spawn(["sudo", "-n", "true"])).code === 0) return true;
    // No terminal here: the controller prompts locally and sends the password through the SSH channel.
    for (let attempt = 1; attempt <= 3; attempt++) {
      this.send({ type: "sudo", attempt });
      const { password } = await this.inbox.expect("sudo");
      if (password === null) return false;
      // Validates and caches the credential for this process' later `sudo -n` calls.
      if ((await spawn(["sudo", "-S", "-p", "", "-v"], { stdin: password + "\n" })).code === 0) return true;
    }
    return false;
  }

  info(message: string) {
    this.send({ type: "info", message });
  }

  warn(message: string) {
    this.send({ type: "warn", message });
  }

  event(e: EventView) {
    this.send({ type: "event", event: e });
  }

  done(d: DoneView) {
    this.send({ type: "done", done: d });
  }

  async verify() {
    this.send({ type: "verify" });
    return (await this.inbox.expect("verify")).ok;
  }
}
