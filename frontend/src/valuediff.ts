// A word-level diff between two values, so a review can say WHICH part of a
// value moved instead of showing the whole thing twice and leaving the reader
// to spot the difference.
//
// Why this exists: a before/after column works when the value is "350m" and
// falls apart when it is a 2,000-character MariaDB block or a login banner.
// Two near-identical walls of text side by side is not a diff; it is a reading
// comprehension test, and the one character that changed is exactly the one a
// reviewer misses. Every surface that shows a value change - the review modal,
// the inspector, the change history - renders through this.

export type DiffOp = "same" | "del" | "ins";

export interface DiffPart {
  op: DiffOp;
  text: string;
}

/** Above this many tokens on a side, the quadratic LCS is abandoned and the
 *  change is reported as a wholesale replacement. Real config values are far
 *  below it; this only guards against a pathological paste. */
const MAX_TOKENS = 1200;

/** Values longer than this are shown truncated until the reader asks for the
 *  rest. Chosen to fill roughly one line of a review table. */
export const LONG_VALUE = 72;

// tokenize splits on word boundaries while KEEPING the separators as their own
// tokens, so "innodb_buffer_pool_size=128M" and "…=256M" differ in one token
// rather than in one giant token, and whitespace/punctuation realign the two
// sides instead of smearing the whole tail red.
function tokenize(s: string): string[] {
  return s.match(/[A-Za-z0-9_.]+|\s+|[^\sA-Za-z0-9_.]/g) ?? [];
}

/** diffValues returns the parts that make up the change from `before` to
 *  `after`. Identical values yield a single "same" part. */
export function diffValues(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ op: "same", text: before }] : [];
  if (!before) return after ? [{ op: "ins", text: after }] : [];
  if (!after) return [{ op: "del", text: before }];

  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    return [
      { op: "del", text: before },
      { op: "ins", text: after },
    ];
  }

  // Trim the shared head and tail first. Config values usually differ in the
  // middle of an otherwise identical string, so this alone reduces most real
  // inputs to a handful of tokens before the LCS table is ever built.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const parts: DiffPart[] = [];
  const push = (op: DiffOp, text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.op === op) last.text += text;
    else parts.push({ op, text });
  };

  push("same", a.slice(0, head).join(""));
  for (const p of lcsDiff(midA, midB)) push(p.op, p.text);
  push("same", a.slice(a.length - tail).join(""));
  return parts;
}

// lcsDiff is the classic longest-common-subsequence table walk over tokens.
function lcsDiff(a: string[], b: string[]): DiffPart[] {
  const n = a.length;
  const m = b.length;
  if (!n && !m) return [];
  if (!n) return [{ op: "ins", text: b.join("") }];
  if (!m) return [{ op: "del", text: a.join("") }];

  // table[i][j] = LCS length of a[i:] and b[j:]
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const out: DiffPart[] = [];
  const push = (op: DiffOp, text: string) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push("del", a[i]);
      i++;
    } else {
      push("ins", b[j]);
      j++;
    }
  }
  while (i < n) push("del", a[i++]);
  while (j < m) push("ins", b[j++]);
  return out;
}

/** changedSummary counts how much of the value actually moved, for the "3
 *  edits in a 2,000-character value" line above an expanded diff. */
export function changedSummary(parts: DiffPart[]): { added: number; removed: number; edits: number } {
  let added = 0;
  let removed = 0;
  let edits = 0;
  let inRun = false;
  for (const p of parts) {
    if (p.op === "same") {
      inRun = false;
      continue;
    }
    if (p.op === "ins") added += p.text.length;
    else removed += p.text.length;
    if (!inRun) edits++;
    inRun = true;
  }
  return { added, removed, edits };
}

/** condense keeps the changed parts and only a little of the unchanged text
 *  around them, so a one-character edit inside a long value can be shown in a
 *  single line without hiding what changed. `context` is how many characters of
 *  unchanged text to keep on each side of a change, and `maxRun` caps a single
 *  changed run - a 400-character insertion is not more informative at full
 *  length in a table row, and the whole value is one click away. Every "…" in
 *  the result stands for text that is elided, never for text that changed and
 *  is being hidden: a change always keeps its head and tail. */
export function condense(parts: DiffPart[], context = 18, maxRun = 64): DiffPart[] {
  if (parts.every((p) => p.op === "same")) return parts;
  const out: DiffPart[] = [];
  parts.forEach((p, idx) => {
    if (p.op !== "same") {
      out.push(
        p.text.length <= maxRun
          ? p
          : {
              op: p.op,
              text: `${p.text.slice(0, Math.ceil(maxRun / 2))}…${p.text.slice(-Math.floor(maxRun / 2))}`,
            },
      );
      return;
    }
    const first = idx === 0;
    const last = idx === parts.length - 1;
    if (p.text.length <= context * 2) {
      out.push(p);
      return;
    }
    // A leading/trailing run only needs context on the side facing a change.
    const headText = first ? "" : p.text.slice(0, context);
    const tailText = last ? "" : p.text.slice(-context);
    out.push({ op: "same", text: `${headText}…${tailText}` });
  });
  return out;
}
