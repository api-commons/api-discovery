// HAR ingestion — evidence-based API discovery from real HTTP traffic.
//
// Given a HAR file (browser DevTools / proxy export), group entries by host and
// templated path, collect methods, query params, request/response headers, and
// infer a shallow JSON Schema from response bodies. Emit one synthesized OpenAPI
// per host — the evidence-based inventory the tool then scores.
import { stringify } from 'yaml';
import { isObject } from './doc';
import type { ApiProperty } from './storage';

interface HarHeader { name: string; value: string }
interface HarEntry {
  request?: {
    method?: string;
    url?: string;
    queryString?: { name: string; value: string }[];
    headers?: HarHeader[];
  };
  response?: {
    status?: number;
    content?: { mimeType?: string; text?: string };
    headers?: HarHeader[];
  };
}

export interface HarApi {
  host: string;
  openapiYaml: string;
  operationCount: number;
  properties: ApiProperty[]; // operational APIs.json properties derived from the traffic
}

// Skip infrastructure/telemetry headers that aren't part of the API contract.
const HEADER_DENY = new Set([
  'host', 'connection', 'content-length', 'accept-encoding', 'user-agent', 'referer', 'origin',
  'cookie', 'set-cookie', 'date', 'cache-control', 'pragma', 'sec-fetch-mode', 'sec-fetch-site',
  'sec-fetch-dest', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'accept-language',
]);

const templateSeg = (seg: string): string => {
  if (/^\d+$/.test(seg)) return '{id}';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{uuid}';
  if (/^[0-9a-f]{16,}$/i.test(seg)) return '{hash}';
  return seg;
};

const templatePath = (pathname: string): { path: string; params: string[] } => {
  const params: string[] = [];
  const path = pathname
    .split('/')
    .map((seg) => {
      const t = templateSeg(seg);
      if (t !== seg) params.push(t.slice(1, -1));
      return t;
    })
    .join('/') || '/';
  return { path, params };
};

// Very shallow JSON Schema inference from a parsed body.
function inferSchema(v: any, depth = 0): any {
  if (depth > 4) return {};
  if (Array.isArray(v)) return { type: 'array', items: v.length ? inferSchema(v[0], depth + 1) : {} };
  if (isObject(v)) {
    const properties: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) properties[k] = inferSchema(val, depth + 1);
    return { type: 'object', properties };
  }
  if (typeof v === 'number') return { type: Number.isInteger(v) ? 'integer' : 'number' };
  if (typeof v === 'boolean') return { type: 'boolean' };
  if (v === null) return { nullable: true };
  return { type: 'string' };
}

const dedupeHeaders = (names: string[]) =>
  [...new Set(names.map((n) => n.toLowerCase()))].filter((n) => !HEADER_DENY.has(n) && !n.startsWith(':'));

interface OpAcc {
  method: string;
  query: Set<string>;
  headers: Set<string>;
  statuses: Set<number>;
  responseSchema?: any;
}

export function parseHar(text: string): HarApi[] {
  let har: any;
  try {
    har = JSON.parse(text);
  } catch {
    throw new Error('Not valid HAR JSON.');
  }
  const entries: HarEntry[] = har?.log?.entries || [];
  if (!Array.isArray(entries) || !entries.length) throw new Error('HAR has no log.entries.');

  // host -> path -> "METHOD" -> accumulator
  const byHost = new Map<string, Map<string, Map<string, OpAcc>>>();
  const pathParams = new Map<string, Set<string>>(); // host+path -> param names
  const authByHost = new Map<string, string | true>(); // host -> auth endpoint path (or true if only header-based)
  const authRe = /(?:^|\/)(login|log-in|signin|sign-in|oauth|oauth2|token|authorize|authenticate|auth|sso)(?:\/|$)/i;

  for (const e of entries) {
    const url = e.request?.url;
    const method = (e.request?.method || 'GET').toLowerCase();
    if (!url) continue;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    // ignore static asset noise
    if (/\.(js|css|png|jpe?g|gif|svg|woff2?|ico|map|mp4|webp)(\?|$)/i.test(u.pathname)) continue;

    const host = u.host;
    const { path, params } = templatePath(u.pathname);
    const ppKey = `${host}${path}`;
    if (params.length) pathParams.set(ppKey, new Set([...(pathParams.get(ppKey) || []), ...params]));

    // Detect an authentication signal for this host: an auth-looking path (kept
    // as the Login URL) or an auth header/api-key on any request.
    const hdrNames = (e.request?.headers || []).map((h) => (h.name || '').toLowerCase());
    if (authRe.test(u.pathname)) authByHost.set(host, path);
    else if (!authByHost.has(host) && (hdrNames.includes('authorization') || hdrNames.includes('x-api-key') || hdrNames.includes('api-key'))) authByHost.set(host, true);

    const paths = byHost.get(host) || byHost.set(host, new Map()).get(host)!;
    const ops = paths.get(path) || paths.set(path, new Map()).get(path)!;
    const acc = ops.get(method) || { method, query: new Set(), headers: new Set(), statuses: new Set() };

    (e.request?.queryString || []).forEach((q) => q.name && acc.query.add(q.name));
    dedupeHeaders((e.request?.headers || []).map((h) => h.name)).forEach((h) => acc.headers.add(h));
    if (typeof e.response?.status === 'number') acc.statuses.add(e.response.status);

    const ct = e.response?.content;
    if (ct?.text && (ct.mimeType || '').includes('json') && !acc.responseSchema) {
      try {
        acc.responseSchema = inferSchema(JSON.parse(ct.text));
      } catch {
        /* non-JSON or truncated body */
      }
    }
    ops.set(method, acc);
  }

  const out: HarApi[] = [];
  for (const [host, paths] of byHost) {
    let opCount = 0;
    const oapiPaths: Record<string, any> = {};
    for (const [path, ops] of paths) {
      const item: Record<string, any> = {};
      const ppKey = `${host}${path}`;
      const pathParamNames = [...(pathParams.get(ppKey) || [])];
      if (pathParamNames.length) {
        item.parameters = pathParamNames.map((n) => ({ name: n, in: 'path', required: true, schema: { type: 'string' } }));
      }
      for (const [method, acc] of ops) {
        opCount++;
        const parameters = [
          ...[...acc.query].map((n) => ({ name: n, in: 'query', schema: { type: 'string' } })),
          ...[...acc.headers].map((n) => ({ name: n, in: 'header', schema: { type: 'string' } })),
        ];
        const responses: Record<string, any> = {};
        const statuses = acc.statuses.size ? [...acc.statuses] : [200];
        for (const s of statuses) {
          responses[String(s)] = {
            description: 'Observed from HAR traffic',
            ...(acc.responseSchema && s < 400
              ? { content: { 'application/json': { schema: acc.responseSchema } } }
              : {}),
          };
        }
        item[method] = {
          summary: `${method.toUpperCase()} ${path} (from traffic)`,
          operationId: `${method}${path.replace(/[^a-z0-9]+/gi, '_')}`.replace(/_+/g, '_'),
          ...(parameters.length ? { parameters } : {}),
          responses,
        };
      }
      oapiPaths[path] = item;
    }

    const doc = {
      openapi: '3.0.3',
      info: {
        title: `${host} (discovered from HAR)`,
        version: '0.0.0',
        description: `Evidence-based API inventory synthesized from ${host} traffic. Paths and parameters are observed, not authoritative — treat as a discovery starting point.`,
      },
      servers: [{ url: `https://${host}` }],
      paths: oapiPaths,
    };
    // Starter operational properties derived from the traffic.
    const properties: ApiProperty[] = [];
    const auth = authByHost.get(host);
    if (auth) properties.push({ type: 'Login', url: `https://${host}${typeof auth === 'string' ? auth : ''}` });

    out.push({ host, openapiYaml: stringify(doc), operationCount: opCount, properties });
  }

  return out.sort((a, b) => b.operationCount - a.operationCount);
}
