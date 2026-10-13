// Controller side of a remote run: push rig and the bundled config over SSH,
// start `rig <cmd> --bundle - --events ndjson` on the target, and render its
// event stream with the local terminal session.

import { ConfigError, gitCommit, type Target } from "../engine.ts";
import { lines } from "../resources/util.ts";
import type { Facts } from "../types.ts";
import type { TerminalSession } from "../cli/session.ts";
import { err, out, readHidden } from "../cli/ui.ts";
import { ensureRemoteBinary, localBinary } from "./binary.ts";
import { buildBundle } from "./bundle.ts";
import { Inbox, type FromTarget, type ToTarget } from "./protocol.ts";
import { Ssh } from "./ssh.ts";

export interface RemoteRun {
  cmd: "plan" | "apply" | "facts";
  target: Target;
  /** Flags passed through to the remote rig (--force, --only, …). */
  flags: string[];
  session: TerminalSession;
  /** Where `facts` output goes (default: stdout). */
  output?: (text: string) => void;
}

export async function runRemote(r: RemoteRun): Promise<number> {
  const connect = r.target.hostDef.connect!;
  const ssh = new Ssh(connect);
  const s = r.session;
  try {
    const probe = await ssh.run(["sh", "-c", 'uname -m; printf "%s\\n" "$HOME"; grep -qw avx2 /proc/cpuinfo && echo avx2 || echo baseline']);
    if (probe.code !== 0) throw new Error(`ssh ${connect.ssh} failed: ${probe.stderr.trim() || `exit ${probe.code}`}`);
    const [machine, home, cpu] = lines(probe.stdout);
    if (!machine || !home) throw new Error(`unexpected answer from ${connect.ssh}: ${probe.stdout.trim()}`);
    const bin = await ensureRemoteBinary(ssh, await localBinary(machine, cpu === "baseline", (m) => s.info(m)), home, (m) => s.info(m));

    // Facts come from the target; the local evaluation below needs them to know what to bundle.
    const f = await ssh.run([bin, "facts"]);
    if (f.code !== 0) throw new Error(`rig facts on ${connect.ssh} failed: ${f.stderr.trim() || `exit ${f.code}`}`);
    const facts = JSON.parse(f.stdout) as Facts;
    if (r.cmd === "facts") {
      let text = JSON.stringify(facts, null, 2);
      // Extra flags (--packages) need another round trip; plain facts we already have.
      if (r.flags.length) {
        const more = await ssh.run([bin, "facts", ...r.flags]);
        if (more.code !== 0) throw new Error(`rig facts on ${connect.ssh} failed: ${more.stderr.trim() || `exit ${more.code}`}`);
        text = more.stdout.trim();
      }
      (r.output ?? out)(text);
      return 0;
    }
    if (r.target.hostDef.os !== facts.os.family)
      throw new ConfigError([`host ${r.target.hostName} is declared os: "${r.target.hostDef.os}" but ${connect.ssh} runs ${facts.os.name} (${facts.os.family})`]);

    const bundle = await buildBundle(r.target, facts, await gitCommit(r.target.repo));
    const proc = ssh.spawn([bin, r.cmd, "--bundle", "-", "--events", "ndjson", ...r.flags]);
    const send = (m: ToTarget) => {
      proc.stdin.write(JSON.stringify(m) + "\n");
      proc.stdin.flush();
    };
    send({ type: "bundle", bundle });

    // Anything that isn't a protocol message (a crash, a stray print) is shown as is.
    const inbox = new Inbox<FromTarget>(proc.stdout, (line) => err(line));
    let failure: Extract<FromTarget, { type: "error" }> | null = null;
    for (let m = await inbox.next(); m; m = await inbox.next()) {
      switch (m.type) {
        case "plan":
          s.plan(m.plan);
          break;
        case "confirm":
          send({ type: "confirm", ok: await s.confirm(m.question) });
          break;
        case "sudo": {
          if (connect.sudo === "nopasswd") {
            s.warn(`sudo on ${connect.ssh} asks for a password, but the host is configured with sudo: "nopasswd"`);
            send({ type: "sudo", password: null });
            break;
          }
          send({ type: "sudo", password: await readHidden(`[sudo] password for ${connect.ssh}${m.attempt > 1 ? " (try again)" : ""}: `) });
          break;
        }
        case "info":
          s.info(m.message);
          break;
        case "warn":
          s.warn(m.message);
          break;
        case "event":
          s.event(m.event);
          break;
        case "verify":
          s.info(`checking that a fresh SSH login to ${connect.ssh} works …`);
          send({ type: "verify", ok: await ssh.fresh() });
          break;
        case "done":
          s.done(m.done);
          break;
        case "error":
          failure = m;
          break;
      }
    }
    proc.stdin.end();
    const code = await proc.exited;
    if (failure) throw failure.problems ? new ConfigError(failure.problems) : new Error(`${connect.ssh}: ${failure.message}`);
    return code;
  } finally {
    await ssh.close();
  }
}
