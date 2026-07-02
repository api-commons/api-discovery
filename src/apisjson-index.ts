// Build APIs.json 0.21 (YAML) for a CATALOG — the ephemeral, purpose-scoped
// index this tool exists to compose. The document carries the catalog's scope as
// tags, its members with their properties, its capability map (x-capabilities),
// and — the thesis made machine-readable — its RECIPE (x-recipe), so any consumer
// can see exactly how this catalog was composed and regenerate it.
import { stringify } from 'yaml';
import { parseDoc, isObject } from './doc';
import { resolveProperties } from './properties';
import { capabilitiesForCatalog } from './storage';
import type { Catalog, SavedArtifact } from './storage';

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'api';
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

function baseURLOf(content: string): string {
  const d = parseDoc(content);
  const s = d?.servers;
  if (Array.isArray(s) && s[0]?.url) return String(s[0].url);
  return '';
}
function descOf(content: string, fallback: string): string {
  const d = parseDoc(content);
  return String(d?.info?.description || d?.info?.title || fallback).trim();
}

// APIs.json 0.21 property type for a stored artifact format.
const TYPE_MAP: Record<string, string> = {
  openapi: 'OpenAPI', asyncapi: 'AsyncAPI', 'apis-json': 'X-APIsJSON',
  jsonschema: 'JSONSchema', 'json-schema': 'JSONSchema', 'json-structure': 'JSONStructure',
  'json-ld': 'JSONLD', arazzo: 'Arazzo', mcp: 'X-MCP', plans: 'X-Plans',
  'rate-limits': 'X-RateLimits', finops: 'X-FinOps', 'agent-skill': 'X-AgentSkill',
};

function entryFor(a: SavedArtifact) {
  const props = resolveProperties(a).filter((p) => p.type);
  const fmt = TYPE_MAP[a.format || 'openapi'] || 'OpenAPI';
  const entry: any = {
    name: a.name,
    description: descOf(a.content, a.name),
    image: '',
    baseURL: baseURLOf(a.content) || 'https://api.example.com',
    humanURL: a.provenance?.url || '',
    properties: [
      { type: fmt, name: `${a.name} ${fmt}`, url: a.provenance?.url || `${slug(a.name)}.${a.lang}` },
      ...props.map((p) => ({ type: p.type, ...(p.name ? { name: p.name } : {}), url: p.url })),
    ],
  };
  return entry;
}

export function buildCatalogApisJson(catalog: Catalog, pool: SavedArtifact[]): string {
  const byId = new Map(pool.map((a) => [a.id, a]));
  const members = catalog.artifactIds.map((id) => byId.get(id)).filter(Boolean) as SavedArtifact[];
  const tags = [catalog.scope.org, catalog.scope.team, catalog.scope.domain, catalog.scope.category].filter(Boolean) as string[];

  const doc: any = {
    specificationVersion: '0.21',
    name: catalog.name,
    description: catalog.description || `Purpose-built catalog of ${members.length} API${members.length === 1 ? '' : 's'} — an ephemeral view, composed on demand.`,
    ...(tags.length ? { tags } : {}),
    created: day(catalog.createdAt),
    modified: day(catalog.modifiedAt),
    apis: members.map(entryFor),
  };

  // Capability map — the catalog's named units of business function.
  const caps = capabilitiesForCatalog(catalog.id);
  if (caps.length) {
    const nameOf = (id: string) => byId.get(id)?.name;
    doc['x-capabilities'] = caps.map((c) => ({
      name: c.name,
      ...(c.domain ? { domain: c.domain } : {}),
      ...(c.description ? { description: c.description } : {}),
      ...(c.canonicalId && nameOf(c.canonicalId) ? { canonical: nameOf(c.canonicalId) } : {}),
      implementations: c.apiIds.map(nameOf).filter(Boolean),
    }));
  }

  // The recipe — how this catalog was composed, so it can be regenerated.
  if (catalog.recipe?.steps?.length) doc['x-recipe'] = catalog.recipe;

  doc.rules = [{ type: 'SpectralRules', name: 'API Commons Rulesets', url: 'https://apicommons.org/rulesets/' }];
  return stringify(doc);
}

// Best-effort format detection for pasted/imported content (kept from the
// original tool so Save-to-pool can tag a format).
export function detectFormat(content: string): string {
  const d = parseDoc(content);
  if (isObject(d)) {
    if (d.openapi || d.swagger) return 'openapi';
    if (d.asyncapi) return 'asyncapi';
    if (d.specificationVersion && d.apis) return 'apis-json';
    if (d.arazzo) return 'arazzo';
    if (d['@context']) return 'json-ld';
    if (d.$schema && (d.properties || d.type || d.$defs)) return 'json-schema';
  }
  if (/^---\n[\s\S]*?\n---/.test(content)) return 'agent-skill';
  return 'openapi';
}
