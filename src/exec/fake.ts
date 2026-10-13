import type { Executor, RunOptions, RunResult } from "../types.ts";
import { UserExecutor } from "./local.ts";

export type RunHandler = (argv: string[], opts?: RunOptions) => RunResult | Promise<RunResult> | undefined;

/**
 * Test executor: filesystem ops go to the real filesystem (point it at a temp
 * dir), commands are recorded and answered by a handler instead of spawned.
 */
export class FakeExecutor extends UserExecutor implements Executor {
  override readonly privileged: boolean;
  readonly calls: string[][] = [];
  handlers: RunHandler[] = [];

  constructor(opts: { privileged?: boolean; handlers?: RunHandler[] } = {}) {
    super();
    this.privileged = opts.privileged ?? false;
    this.handlers = opts.handlers ?? [];
  }

  on(handler: RunHandler) {
    this.handlers.push(handler);
    return this;
  }

  override async run(argv: string[], opts?: RunOptions): Promise<RunResult> {
    this.calls.push(argv);
    for (const h of this.handlers) {
      const r = await h(argv, opts);
      if (r) return r;
    }
    return { code: 0, stdout: "", stderr: "" };
  }
}

export const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
export const fail = (stderr = "failed", code = 1): RunResult => ({ code, stdout: "", stderr });
