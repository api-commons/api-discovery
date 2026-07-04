// Client-side persistence for the ephemeral-catalog composer.
//
// The data model IS the thesis: one shared artifact POOL (everything the org has
// discovered), and any number of CATALOGS — named, purpose-scoped views that
// reference pool artifacts. The same API can live in many catalogs; deleting a
// catalog never deletes an artifact. Catalogs carry a RECIPE (how they were
// composed) so they can be regenerated — a catalog is a build artifact, not a
// database.

export interface Provenance {
  source: 'apis.io' | 'github' | 'gitlab' | 'bitbucket' | 'swaggerhub' | 'postman' | 'har' | 'helper' | 'url' | 'manual' | 'sample';
  url?: string; // where it was found / its source URL
  repo?: string; // owner/repo (or workspace/repo)
  path?: string; // file path in the repo
  ref?: string; // branch/ref
  aid?: string; // APIs.io artifact id
  gateway?: string; // helper-collected gateway origin
}

// An APIs.json property — operational (docs/signup/sandbox/…) or composability
// (Arazzo/MCP/…) metadata attached to an artifact. Shared with properties.ts.
export interface ApiProperty {
  type: string;
  name?: string;
  url: string;
}

export interface SavedArtifact {
  id: string;
  name: string;
  format?: string; // artifact type id (openapi, asyncapi, agent-skill, …)
  lang: 'yaml' | 'json';
  content: string;
  properties?: ApiProperty[]; // APIs.json properties (chips)
  apisjson?: string; // legacy raw apis.json fragment (read on import for back-compat)
  provenance: Provenance;
  savedAt: number;
}

// How a catalog was composed — replayable so the catalog can be REGENERATED.
export interface RecipeStep {
  kind: 'search' | 'scan' | 'semantic' | 'set';
  source?: string; // search/scan source id
  artifactType?: string; // artifact type id
  query?: string; // keyword or intent text
  threshold?: number; // semantic match cutoff (0..1)
  setId?: string; // example-set id (kind: 'set')
}
export interface Recipe {
  steps: RecipeStep[];
}

// A catalog — a named, purpose-built, ephemeral view over the pool.
export interface Catalog {
  id: string;
  name: string;
  description?: string;
  scope: { org?: string; team?: string; domain?: string; category?: string };
  artifactIds: string[]; // references into the pool
  recipe?: Recipe;
  createdAt: number;
  modifiedAt: number;
}

// A capability — a named unit of business function that N catalog members
// implement. Scoped to a catalog (capability maps are per-purpose too).
export interface Capability {
  id: string;
  catalogId: string;
  name: string;
  description?: string;
  domain?: string;
  apiIds: string[]; // SavedArtifact ids
  canonicalId?: string; // the implementation to standardize on
  createdAt: number;
}

const DOCS = 'api-discovery:artifacts';
const CATS = 'api-discovery:catalogs';
const CAPS = 'api-discovery:capabilities';
const CFG = 'api-discovery:config';
const SEEDED = 'api-discovery:seeded';

export interface Config {
  githubToken?: string;
  gitlabToken?: string;
  bitbucketUser?: string;
  bitbucketToken?: string;
  swaggerhubToken?: string;
  postmanApiKey?: string;
  defaultRepo?: string; // owner/repo for GitHub saves
  defaultBranch?: string;
  federationBaseUrl?: string; // where per-catalog APIs.json files get published
  sources?: Record<string, boolean>;
}

const read = <T>(k: string, fallback: T): T => {
  try {
    const v = JSON.parse(localStorage.getItem(k) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* disabled / quota */
  }
};

// ---- pool -------------------------------------------------------------------
export const loadArtifacts = (): SavedArtifact[] => read<SavedArtifact[]>(DOCS, []);
export const saveArtifacts = (a: SavedArtifact[]) => write(DOCS, a);
export function upsertArtifact(a: SavedArtifact) {
  const all = loadArtifacts();
  const i = all.findIndex((x) => x.id === a.id);
  if (i >= 0) all[i] = a;
  else all.push(a);
  saveArtifacts(all);
}
export function removeArtifact(id: string) {
  saveArtifacts(loadArtifacts().filter((a) => a.id !== id));
  // drop the reference from every catalog and capability
  saveCatalogs(loadCatalogs().map((c) => ({ ...c, artifactIds: c.artifactIds.filter((x) => x !== id) })));
  saveCapabilities(loadCapabilities().map((c) => ({
    ...c,
    apiIds: c.apiIds.filter((x) => x !== id),
    canonicalId: c.canonicalId === id ? undefined : c.canonicalId,
  })));
}
export const getArtifact = (id: string) => loadArtifacts().find((a) => a.id === id);

// Example-set helpers (sample provenance can be cleared independently).
export const hasSamples = () => loadArtifacts().some((a) => a.provenance.source === 'sample');
export function clearSamples() {
  const keep = loadArtifacts().filter((a) => a.provenance.source !== 'sample');
  const dropped = new Set(loadArtifacts().filter((a) => a.provenance.source === 'sample').map((a) => a.id));
  saveArtifacts(keep);
  saveCatalogs(loadCatalogs().map((c) => ({ ...c, artifactIds: c.artifactIds.filter((x) => !dropped.has(x)) })));
}
export const wasSeeded = () => { try { return localStorage.getItem(SEEDED) === '1'; } catch { return false; } };
export const markSeeded = () => { try { localStorage.setItem(SEEDED, '1'); } catch { /* */ } };

// ---- catalogs -----------------------------------------------------------------
export const loadCatalogs = (): Catalog[] => read<Catalog[]>(CATS, []);
export const saveCatalogs = (c: Catalog[]) => write(CATS, c);
export function upsertCatalog(c: Catalog) {
  const all = loadCatalogs();
  const i = all.findIndex((x) => x.id === c.id);
  if (i >= 0) all[i] = c;
  else all.push(c);
  saveCatalogs(all);
}
export function removeCatalog(id: string) {
  saveCatalogs(loadCatalogs().filter((c) => c.id !== id));
  saveCapabilities(loadCapabilities().filter((c) => c.catalogId !== id));
}
export const getCatalog = (id: string) => loadCatalogs().find((c) => c.id === id);

// ---- capabilities --------------------------------------------------------------
export const loadCapabilities = (): Capability[] => read<Capability[]>(CAPS, []);
export const saveCapabilities = (c: Capability[]) => write(CAPS, c);
export function upsertCapability(c: Capability) {
  const all = loadCapabilities();
  const i = all.findIndex((x) => x.id === c.id);
  if (i >= 0) all[i] = c;
  else all.push(c);
  saveCapabilities(all);
}
export const removeCapability = (id: string) => saveCapabilities(loadCapabilities().filter((c) => c.id !== id));
export const getCapability = (id: string) => loadCapabilities().find((c) => c.id === id);
export const capabilitiesForCatalog = (catalogId: string) => loadCapabilities().filter((c) => c.catalogId === catalogId);

// ---- config --------------------------------------------------------------------
export const loadConfig = (): Config => read<Config>(CFG, {});
export const saveConfig = (c: Config) => write(CFG, c);

export const newId = () => globalThis.crypto?.randomUUID?.() ?? 'a' + Math.random().toString(36).slice(2) + Date.now().toString(36);
