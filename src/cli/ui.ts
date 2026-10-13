const enabled = !process.env.NO_COLOR && (process.env.FORCE_COLOR ? true : !!process.stdout.isTTY);

const wrap = (open: number, close: number) => (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s);

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
};

export const out = (s = "") => process.stdout.write(s + "\n");
export const err = (s = "") => process.stderr.write(s + "\n");

export function confirm(question: string): boolean {
  if (!process.stdin.isTTY) return false;
  const answer = prompt(`${question} [y/N]`);
  return /^y(es)?$/i.test(answer?.trim() ?? "");
}

/** Read a line from the terminal without echoing it (passwords). Null without a terminal. */
export async function readHidden(question: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  process.stderr.write(question);
  // /dev/tty directly: stdin may be busy, and stty must act on the real terminal.
  const proc = Bun.spawn(["sh", "-c", 'stty -echo < /dev/tty; trap "stty echo < /dev/tty" EXIT; IFS= read -r l < /dev/tty && printf %s "$l"'], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "inherit",
  });
  const [line, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  process.stderr.write("\n");
  return code === 0 ? line : null;
}
