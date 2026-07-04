// APIs.io API client. Read-only; no key needed.
const BASE = 'https://apis.io/api/v1';

export interface SearchHit {
  aid: string;
  name: string;
  provider_slug?: string;
  provider_name?: string;
  type: string;
  url: string;
}

// Search one artifact-type collection (e.g. 'openapis', 'apis-json', 'mcp').
export async function searchArtifacts(endpoint: string, q: string, limit = 25): Promise<SearchHit[]> {
  const u = new URL(`${BASE}/${endpoint}`);
  if (q) u.searchParams.set('q', q);
  u.searchParams.set('limit', String(limit));
  const res = await fetch(u.toString(), { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`APIs.io returned ${res.status}`);
  const data = await res.json();
  return (data?.data ?? []) as SearchHit[];
}

// Load a selected artifact's raw content. Prefers the API's single-artifact content
// inlining (first-class path); falls back to fetching the source URL directly.
export async function loadArtifactContent(hit: SearchHit): Promise<string> {
  if (hit.aid) {
    try {
      const u = new URL(`${BASE}/apis/${encodeURIComponent(hit.aid)}`);
      u.searchParams.set('include', 'content');
      if (hit.type) u.searchParams.set('artifact_types', hit.type);
      const res = await fetch(u.toString(), { headers: { accept: 'application/json' } });
      if (res.ok) {
        const data = await res.json();
        const props: any[] = data?.properties ?? [];
        const match = props.find((p) => p.url === hit.url) ?? props[0];
        if (match?.content) return String(match.content);
      }
    } catch {
      /* fall through to direct fetch */
    }
  }
  const r = await fetch(hit.url);
  if (!r.ok) throw new Error(`Could not fetch artifact (${r.status})`);
  return r.text();
}
