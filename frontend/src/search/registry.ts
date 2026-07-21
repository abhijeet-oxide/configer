// The provider registry and the ranking layer. Providers register once; the
// palette calls queryAll, which fans out to the providers matching the current
// surface, awaits them, then ranks every hit uniformly. Providers stay dumb:
// they emit candidate hits with a title and keywords, and ranking here decides
// order, so relevance behaves the same across entity types.

import type { SearchContext, SearchHit, SearchProvider } from "./types";
import { fuzzyBest } from "./fuzzy";

const providers: SearchProvider[] = [];

/** Register a source of results. Adding a new searchable entity type is this
 *  one call - the palette never changes. */
export function register(provider: SearchProvider): void {
  // Replace by id so a re-imported module does not double-register.
  const i = providers.findIndex((p) => p.id === provider.id);
  if (i >= 0) providers[i] = provider;
  else providers.push(provider);
}

// A small per-type bias that only breaks ties (fuzzy relevance dominates when
// there is a query). It also gives a sensible default order for an empty query:
// applications and instances lead, bare navigation trails.
const TYPE_BIAS: Record<SearchHit["type"], number> = {
  application: 60,
  instance: 55,
  parameter: 50,
  change: 45,
  file: 40,
  command: 30,
};

const MAX_RESULTS = 40;

/** Run every provider for the context's mode, then rank and cap the results. */
export async function queryAll(ctx: SearchContext, q: string): Promise<SearchHit[]> {
  const active = providers.filter((p) => p.scope === "both" || p.scope === ctx.mode);
  const groups = await Promise.all(
    active.map((p) =>
      Promise.resolve(p.query(ctx, q)).catch(() => [] as SearchHit[]),
    ),
  );
  return rank(q, groups.flat());
}

function rank(q: string, hits: SearchHit[]): SearchHit[] {
  const query = q.trim();
  const scored: SearchHit[] = [];
  for (const h of hits) {
    const bias = TYPE_BIAS[h.type] ?? 0;
    if (!query) {
      scored.push({ ...h, score: bias });
      continue;
    }
    // Title carries more weight than the keyword haystack.
    const best = fuzzyBest(query, [h.title, h.keywords], [2, 1]);
    if (best === null) continue; // no match: drop it
    scored.push({ ...h, score: best + bias });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_RESULTS);
}
