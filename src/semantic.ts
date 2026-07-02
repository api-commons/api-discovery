// Client-side semantic engine. Lazy-loads a small sentence-embedding model
// (all-MiniLM-L6-v2, ~23MB quantized) via transformers.js and runs it entirely in
// the browser (WASM) — no backend, nothing leaves the page. Used for semantic
// intent search ("find what does this, however it's named") and semantic
// duplicate detection ("these are the same capability, differently named").
import { parseDoc, isObject } from './doc';

type StatusFn = (s: string) => void;

let extractorPromise: Promise<any> | null = null;
async function getExtractor(onStatus?: StatusFn) {
  if (!extractorPromise) {
    onStatus?.('Loading semantic model (~23 MB, first time only)…');
    extractorPromise = import('@xenova/transformers').then(async (mod) => {
      mod.env.allowLocalModels = false; // fetch the model from the HF CDN
      return mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });
    });
  }
  return extractorPromise;
}

// Whether the model has already been pulled (so the UI can warn about the download).
export const semanticReady = () => extractorPromise !== null;

// Turn an API record into a compact text document for embedding: name, title,
// description, tags, path templates, and operation summaries.
export function buildApiText(name: string, openapi: string, tags: string[] = []): string {
  const d = parseDoc(openapi);
  const parts: string[] = [name];
  if (isObject(d)) {
    if (d.info?.title) parts.push(String(d.info.title));
    if (d.info?.description) parts.push(String(d.info.description));
    parts.push(...tags);
    const paths = isObject(d.paths) ? d.paths : {};
    for (const [p, item] of Object.entries<any>(paths)) {
      parts.push(p.replace(/[{}]/g, ' ').replace(/[/_-]+/g, ' '));
      if (!isObject(item)) continue;
      for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
        if (isObject(item[m])) parts.push(item[m].summary || item[m].operationId || '');
      }
    }
  }
  return parts.filter(Boolean).join(' . ').slice(0, 2000);
}

const cache = new Map<string, Float32Array>();
const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h); };

// Embed texts (mean-pooled, L2-normalized). Cached by content hash, so repeated
// calls over the same inventory are instant. Batched with progress.
export async function embed(texts: string[], onStatus?: StatusFn): Promise<Float32Array[]> {
  const out: (Float32Array | null)[] = texts.map((t) => cache.get(hash(t)) ?? null);
  const todo = texts.map((t, i) => ({ t, i })).filter((x) => out[x.i] === null);
  if (todo.length) {
    const extractor = await getExtractor(onStatus);
    const B = 16;
    for (let b = 0; b < todo.length; b += B) {
      const chunk = todo.slice(b, b + B);
      onStatus?.(`Embedding ${Math.min(b + B, todo.length)}/${todo.length}…`);
      const res = await extractor(chunk.map((c) => c.t), { pooling: 'mean', normalize: true });
      const dim = res.dims[res.dims.length - 1];
      for (let k = 0; k < chunk.length; k++) {
        const vec = Float32Array.from(res.data.slice(k * dim, (k + 1) * dim));
        cache.set(hash(chunk[k].t), vec);
        out[chunk[k].i] = vec;
      }
    }
  }
  return out as Float32Array[];
}

// Cosine similarity of two L2-normalized vectors = their dot product.
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
