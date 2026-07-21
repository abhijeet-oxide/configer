// A tiny, dependency-free fuzzy matcher. Higher scores are better; null means
// "no match" so the caller can drop the candidate. It rewards contiguous
// substring hits over scattered subsequences, and word-boundary/prefix matches
// over mid-word ones, which is what makes "nap" find "network.admin.port" while
// still ranking "admin" above it. Kept small on purpose - at our scale a linear
// scan of tens of thousands of short strings is well under a frame, so there is
// no need for an index or a third-party library.

// A boundary is anything that is not a letter or digit ("." "_" "/" "-" space),
// i.e. the start of a new word in an identifier or path.
function isBoundary(ch: string | undefined): boolean {
  return ch === undefined || !/[a-z0-9]/i.test(ch);
}

/** Score how well `query` matches `text`. Returns null when it does not. */
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Contiguous substring: the strongest signal.
  const sub = t.indexOf(q);
  if (sub !== -1) {
    let s = 900 - sub; // earlier is better
    if (isBoundary(t[sub - 1])) s += 120; // starts a word (or the string)
    if (t === q) s += 400; // exact
    return s - (t.length - q.length) * 0.5; // tighter is better
  }

  // Subsequence: every query char appears in order.
  let ti = 0;
  let score = 0;
  let prev = -2;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    let hit = -1;
    while (ti < t.length) {
      if (t[ti] === c) {
        hit = ti;
        break;
      }
      ti++;
    }
    if (hit === -1) return null;
    score += 10;
    if (hit === prev + 1) score += 8; // adjacent to the previous match
    if (isBoundary(t[hit - 1])) score += 6; // on a word boundary
    prev = hit;
    ti = hit + 1;
  }
  return score - t.length * 0.1; // gently prefer shorter fields
}

/** Best score of `query` across several weighted fields (null if none match). */
export function fuzzyBest(
  query: string,
  fields: (string | undefined)[],
  weights?: number[],
): number | null {
  let best: number | null = null;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f) continue;
    const raw = fuzzyScore(query, f);
    if (raw === null) continue;
    const val = raw * (weights?.[i] ?? 1);
    if (best === null || val > best) best = val;
  }
  return best;
}
