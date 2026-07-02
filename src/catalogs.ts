// Catalog lifecycle — the heart of the ephemeral-catalog thesis. A catalog
// remembers its RECIPE (the queries that composed it) and can be REGENERATED
// against the live sources at any time: the catalog is a build artifact, not a
// database. Freshness is first-class — age is displayed, not hidden.
import { searchSource, loadHit, type SourceId, type Tokens, type Hit } from './sources';
import { loadArtifacts, upsertArtifact, upsertCatalog, newId, type Catalog, type Provenance, type SavedArtifact, type RecipeStep } from './storage';
import { detectFormat } from './apisjson-index';
import { embed, cosine, buildApiText } from './semantic';
import { detectLang } from './doc';

// ---- freshness ----------------------------------------------------------------
export function ageLabel(modifiedAt: number): { label: string; cls: 'fresh' | 'aging' | 'stale' } {
  const days = (Date.now() - modifiedAt) / 86_400_000;
  if (days < 1) return { label: 'fresh', cls: 'fresh' };
  if (days < 7) return { label: `${Math.floor(days)}d old`, cls: 'aging' };
  return { label: `${Math.floor(days)}d old — regenerate?`, cls: 'stale' };
}

// A stable identity for a discovered artifact (dedup across scans/regenerations).
export function provKey(p: Provenance): string {
  if (p.source === 'apis.io') return `apis.io:${p.aid || p.url || ''}`;
  if (p.repo || p.path) return `${p.source}:${p.repo || ''}/${p.path || ''}@${p.ref || ''}`;
  return `${p.source}:${p.url || ''}`;
}

export interface RegenReport {
  added: number; // new artifacts pulled into the pool + catalog
  attached: number; // already-pooled artifacts newly matched into the catalog
  kept: number;
  failed: number;
}

// Re-run one search/scan recipe step, pulling hits into the pool (deduped) and
// returning the matching artifact ids.
async function runSourceStep(step: RecipeStep, tokens: Tokens, onStatus: (m: string) => void): Promise<{ ids: string[]; added: number; failed: number }> {
  const artifact = { id: step.artifactType || 'openapi', endpoint: step.artifactType === 'openapi' || !step.artifactType ? 'openapis' : step.artifactType };
  const hits: Hit[] = await searchSource((step.source || 'apis.io') as SourceId, artifact, step.query || '', tokens);
  const byProv = new Map(loadArtifacts().map((a) => [provKey(a.provenance), a.id]));
  const ids: string[] = [];
  let added = 0, failed = 0;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const prov: Provenance = h.source === 'apis.io'
      ? { source: 'apis.io', url: h.url, aid: h.aid }
      : { source: h.source as Provenance['source'], repo: h.repo, path: h.path, ref: h.ref, url: h.url };
    const existing = byProv.get(provKey(prov));
    if (existing) { ids.push(existing); continue; }
    onStatus(`Loading ${i + 1}/${hits.length}: ${h.name}`);
    try {
      const content = await loadHit(h, tokens);
      const rec: SavedArtifact = {
        id: newId(), name: h.name || 'artifact', format: step.artifactType || detectFormat(content),
        lang: detectLang(content), content, provenance: prov, savedAt: Date.now(),
      };
      upsertArtifact(rec);
      byProv.set(provKey(prov), rec.id);
      ids.push(rec.id);
      added++;
    } catch { failed++; }
  }
  return { ids, added, failed };
}

// Re-run a semantic step against the current pool.
async function runSemanticStep(step: RecipeStep, onStatus: (m: string) => void): Promise<string[]> {
  const pool = loadArtifacts();
  if (!pool.length || !step.query) return [];
  const texts = pool.map((a) => buildApiText(a.name, a.content, []));
  const vecs = await embed(texts, onStatus);
  const [q] = await embed([step.query]);
  const th = step.threshold ?? 0.35;
  return pool.filter((_, i) => cosine(q, vecs[i]) >= th).map((a) => a.id);
}

// Regenerate a catalog from its recipe: re-run every step, rebuild the member
// list (set steps keep whatever sample/preset members are already present).
export async function regenerateCatalog(catalog: Catalog, tokens: Tokens, onStatus: (m: string) => void): Promise<RegenReport> {
  const before = new Set(catalog.artifactIds);
  const next = new Set<string>();
  let added = 0, failed = 0;

  for (const step of catalog.recipe?.steps || []) {
    if (step.kind === 'search' || step.kind === 'scan') {
      onStatus(`Re-running ${step.kind} “${step.query || ''}” on ${step.source || 'apis.io'}…`);
      const r = await runSourceStep(step, tokens, onStatus);
      r.ids.forEach((id) => next.add(id));
      added += r.added; failed += r.failed;
    } else if (step.kind === 'semantic') {
      onStatus(`Re-running semantic match “${step.query}”…`);
      (await runSemanticStep(step, onStatus)).forEach((id) => next.add(id));
    } else if (step.kind === 'set') {
      // example-set members: keep the ones already in the catalog
      catalog.artifactIds.forEach((id) => next.add(id));
    }
  }

  const attached = [...next].filter((id) => !before.has(id)).length - added;
  const kept = [...next].filter((id) => before.has(id)).length;
  catalog.artifactIds = [...next];
  catalog.modifiedAt = Date.now();
  upsertCatalog(catalog);
  return { added, attached: Math.max(0, attached), kept, failed };
}
