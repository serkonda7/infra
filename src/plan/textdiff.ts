// Minimal line-based unified diff (LCS). Config files are small; we bail out
// on anything large rather than pulling in a dependency.

const MAX_CELLS = 4_000_000;

type Op = { t: " " | "-" | "+"; line: string };

function lcsOps(a: string[], b: string[]): Op[] | null {
  const n = a.length, m = b.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ t: " ", line: a[i++]! }), j++;
    else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) ops.push({ t: "-", line: a[i++]! });
    else ops.push({ t: "+", line: b[j++]! });
  }
  while (i < n) ops.push({ t: "-", line: a[i++]! });
  while (j < m) ops.push({ t: "+", line: b[j++]! });
  return ops;
}

const splitLines = (s: string) => {
  const lines = s.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** Unified diff with `context` lines around each hunk. Returns null if inputs are too large. */
export function unifiedDiff(before: string, after: string, context = 3): string | null {
  const ops = lcsOps(splitLines(before), splitLines(after));
  if (!ops) return null;
  const out: string[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.t === " ") { k++; continue; }
    // Start a hunk `context` lines before the first change.
    let start = Math.max(0, k - context);
    let end = k;
    // Extend while the gap between changes is ≤ 2*context.
    while (end < ops.length) {
      if (ops[end]!.t !== " ") { end++; continue; }
      let gap = end;
      while (gap < ops.length && ops[gap]!.t === " ") gap++;
      if (gap === ops.length || gap - end > 2 * context) { end = Math.min(ops.length, end + context); break; }
      end = gap;
    }
    let aLine = 1, bLine = 1;
    for (let q = 0; q < start; q++) {
      if (ops[q]!.t !== "+") aLine++;
      if (ops[q]!.t !== "-") bLine++;
    }
    const hunk = ops.slice(start, end);
    const aLen = hunk.filter((o) => o.t !== "+").length;
    const bLen = hunk.filter((o) => o.t !== "-").length;
    out.push(`@@ -${aLine},${aLen} +${bLine},${bLen} @@`);
    for (const o of hunk) out.push(o.t + o.line);
    k = end;
  }
  return out.join("\n");
}

export const looksBinary = (data: Uint8Array) => data.subarray(0, 8000).includes(0);
