// Shared multi-source search: APIs.io (default) + GitHub/GitLab/Bitbucket code
// search. Sources are toggled in Config. Token-arg based (no Config coupling), so
// this module is identical in spotlight-validator and api-discovery.
import { searchArtifacts, loadArtifactContent } from './apisio';

export type SourceId = 'apis.io' | 'github' | 'gitlab' | 'bitbucket' | 'swaggerhub' | 'postman';
export interface SourceDef { id: SourceId; label: string; on: boolean; }
// APIs.io + GitHub on by default; the rest are opt-in (appear once keyed).
export const SOURCES: SourceDef[] = [
  { id: 'apis.io', label: 'APIs.io', on: true },
  { id: 'github', label: 'GitHub', on: true },
  { id: 'gitlab', label: 'GitLab', on: false },
  { id: 'bitbucket', label: 'Bitbucket', on: false },
  { id: 'swaggerhub', label: 'SwaggerHub', on: false },
  { id: 'postman', label: 'Postman', on: false },
];
export const sourceEnabled = (id: SourceId, toggles?: Record<string, boolean>): boolean =>
  toggles?.[id] ?? SOURCES.find((s) => s.id === id)?.on ?? false;
export const enabledSources = (toggles?: Record<string, boolean>): SourceDef[] =>
  SOURCES.filter((s) => sourceEnabled(s.id, toggles));

export interface Tokens { github?: string; gitlab?: string; bitbucketUser?: string; bitbucket?: string; swaggerhub?: string; postman?: string }
export interface Hit { source: SourceId; name: string; repo?: string; path?: string; ref?: string; url?: string; aid?: string; type?: string }

// GitHub code-search qualifier per artifact id (appended to the user's query).
const GH_QUALIFIER: Record<string, string> = {
  'apis-json': 'filename:apis.json', openapi: 'openapi extension:yaml', asyncapi: 'asyncapi extension:yaml',
  arazzo: 'arazzo extension:yaml', 'json-schema': '"$schema" extension:json', 'json-structure': '"$schema" extension:json',
  'json-ld': '"@context"',
  'agent-skill': 'filename:SKILL.md', plans: 'plans extension:yaml', 'rate-limits': 'rate-limits extension:yaml',
  finops: 'finops extension:yaml', mcp: 'mcp extension:json',
};
const b64decode = (s: string) => decodeURIComponent(escape(atob(s.replace(/\s/g, ''))));

export interface ArtifactRef { id: string; endpoint: string }

export async function searchSource(source: SourceId, artifact: ArtifactRef, query: string, tokens: Tokens): Promise<Hit[]> {
  if (source === 'apis.io') {
    const hits = await searchArtifacts(artifact.endpoint, query, 25);
    return hits.map((h) => ({ source: 'apis.io', name: h.name || h.aid, aid: h.aid, type: h.type, url: h.url } as Hit));
  }
  if (source === 'github') {
    if (!tokens.github) throw new Error('GitHub search needs a token (Config).');
    const q = `${query} ${GH_QUALIFIER[artifact.id] || ''}`.trim();
    const res = await fetch(`https://api.github.com/search/code?per_page=25&q=${encodeURIComponent(q)}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${tokens.github}` },
    });
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.json().catch(() => ({})))?.message || res.statusText}`);
    return ((await res.json()).items || []).map((it: any) => ({ source: 'github', name: it.name, repo: it.repository?.full_name, path: it.path, ref: it.repository?.default_branch, url: it.html_url } as Hit));
  }
  if (source === 'gitlab') {
    if (!tokens.gitlab) throw new Error('GitLab search needs a token (Config).');
    const res = await fetch(`https://gitlab.com/api/v4/search?scope=blobs&search=${encodeURIComponent(query || artifact.id)}`, { headers: { authorization: `Bearer ${tokens.gitlab}` } });
    if (!res.ok) throw new Error(`GitLab ${res.status}`);
    return ((await res.json()) || []).map((b: any) => ({ source: 'gitlab', name: b.basename || b.path, repo: String(b.project_id), path: b.path, ref: b.ref } as Hit));
  }
  if (source === 'swaggerhub') {
    // Public spec search across the SwaggerHub registry (token optional — lifts
    // rate limits + includes private specs).
    const u = `https://api.swaggerhub.com/specs?specType=API&limit=25&sort=NAME&order=ASC&query=${encodeURIComponent(query || '')}`;
    const res = await fetch(u, { headers: { accept: 'application/json', ...(tokens.swaggerhub ? { authorization: tokens.swaggerhub } : {}) } });
    if (!res.ok) throw new Error(`SwaggerHub ${res.status}`);
    const data = await res.json();
    return ((data.apis || []) as any[]).map((a) => {
      const props: any[] = a.properties || [];
      const url = props.find((p) => /swagger|openapi/i.test(p.type))?.url || props.find((p) => /swagger\.json|\.ya?ml/i.test(p.url || ''))?.url;
      const owned = url ? (url.split('/apis/')[1] || '').split('/').slice(0, 2).join('/') : '';
      return { source: 'swaggerhub', name: a.name || owned || 'api', url, type: 'OpenAPI' } as Hit;
    }).filter((h) => h.url);
  }
  if (source === 'postman') {
    if (!tokens.postman) throw new Error('Postman search needs an API key (Config).');
    const res = await fetch('https://api.getpostman.com/apis', { headers: { accept: 'application/json', 'x-api-key': tokens.postman } });
    if (!res.ok) throw new Error(`Postman ${res.status} — its API may block browser (CORS); use the helper instead.`);
    const apis: any[] = (await res.json()).apis || [];
    const q = (query || '').toLowerCase();
    return apis
      .filter((a) => !q || `${a.name} ${a.description || ''}`.toLowerCase().includes(q))
      .map((a) => ({ source: 'postman', name: a.name, url: `https://api.getpostman.com/apis/${a.id}`, ref: a.id, type: 'OpenAPI' } as Hit));
  }
  // bitbucket
  if (!tokens.bitbucket || !tokens.bitbucketUser) throw new Error('Bitbucket search needs a username + app password (Config).');
  const res = await fetch(`https://api.bitbucket.org/2.0/workspaces/${tokens.bitbucketUser}/search/code?search_query=${encodeURIComponent(query || artifact.id)}`, { headers: { authorization: 'Basic ' + btoa(`${tokens.bitbucketUser}:${tokens.bitbucket}`) } });
  if (!res.ok) throw new Error(`Bitbucket ${res.status}`);
  return ((await res.json()).values || []).map((v: any) => ({ source: 'bitbucket', name: v.file?.path?.split('/').pop() || 'file', repo: `${tokens.bitbucketUser}/${v.file?.commit?.repository?.name || ''}`, path: v.file?.path, ref: v.file?.commit?.hash } as Hit));
}

export async function loadHit(hit: Hit, tokens: Tokens): Promise<string> {
  if (hit.source === 'apis.io') return loadArtifactContent({ aid: hit.aid!, name: hit.name, type: hit.type || 'OpenAPI', url: hit.url! } as any);
  if (hit.source === 'github') {
    const res = await fetch(`https://api.github.com/repos/${hit.repo}/contents/${hit.path}${hit.ref ? `?ref=${hit.ref}` : ''}`, { headers: { accept: 'application/vnd.github+json', ...(tokens.github ? { authorization: `Bearer ${tokens.github}` } : {}) } });
    if (!res.ok) throw new Error(`GitHub read ${res.status}`);
    return b64decode((await res.json()).content);
  }
  if (hit.source === 'gitlab') {
    const res = await fetch(`https://gitlab.com/api/v4/projects/${hit.repo}/repository/files/${encodeURIComponent(hit.path!)}?ref=${hit.ref || 'HEAD'}`, { headers: { authorization: `Bearer ${tokens.gitlab}` } });
    if (!res.ok) throw new Error(`GitLab read ${res.status}`);
    return b64decode((await res.json()).content);
  }
  if (hit.source === 'swaggerhub') {
    const res = await fetch(hit.url!, { headers: { accept: 'application/json', ...(tokens.swaggerhub ? { authorization: tokens.swaggerhub } : {}) } });
    if (!res.ok) throw new Error(`SwaggerHub read ${res.status}`);
    return res.text();
  }
  if (hit.source === 'postman') {
    const res = await fetch(`${hit.url}?include=schemas`, { headers: { accept: 'application/json', 'x-api-key': tokens.postman! } });
    if (!res.ok) throw new Error(`Postman read ${res.status}`);
    const d = await res.json();
    const schema = d.api?.schemas?.[0] || d.schemas?.[0];
    const content = schema?.schema ?? schema?.content;
    return typeof content === 'string' ? content : JSON.stringify(content ?? d, null, 2);
  }
  const res = await fetch(`https://api.bitbucket.org/2.0/repositories/${hit.repo}/src/${hit.ref || 'HEAD'}/${hit.path}`, { headers: { authorization: 'Basic ' + btoa(`${tokens.bitbucketUser}:${tokens.bitbucket}`) } });
  if (!res.ok) throw new Error(`Bitbucket read ${res.status}`);
  return res.text();
}
