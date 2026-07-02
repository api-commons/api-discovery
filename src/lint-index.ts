// Validate-on-index (P1-lite). Every artifact entering the pool gets linted
// against its type's tiny default ruleset (Spotlight engine, in-browser) and
// stamped with an error/warning count. If catalogs are ephemeral, trust has to
// travel WITH the catalog — the stamp is that trust signal. Deep rule editing
// stays in Spotlight Validator; this is just the stamp.
import { parse as parseYaml } from 'yaml';
import { loadLintCache, saveLintCache, type LintStamp, type SavedArtifact } from './storage';

// The Spotlight engine (+ markdown parser) is heavy — load it lazily so the
// initial bundle stays lean; it only arrives when the first lint runs.
let enginePromise: Promise<{ lint: typeof import('./spotlight')['lint']; Markdown: typeof import('./markdown')['Markdown'] }> | null = null;
const getLintEngine = () => (enginePromise ??= Promise.all([import('./spotlight'), import('./markdown')]).then(([s, m]) => ({ lint: s.lint, Markdown: m.Markdown })));

// Per-artifact-type default rulesets, loaded at build time (tiny YAML files).
const defaultFiles = import.meta.glob('../rules/defaults/*.yaml', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const DEFAULT_RULESETS: Record<string, any> = {};
for (const [path, raw] of Object.entries(defaultFiles)) {
  const id = path.split('/').pop()!.replace(/\.yaml$/, '');
  try { DEFAULT_RULESETS[id] = parseYaml(raw) || {}; } catch { DEFAULT_RULESETS[id] = {}; }
}

const hash = (s: string) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h); };

export function stampFor(a: Pick<SavedArtifact, 'content'>): LintStamp | undefined {
  return loadLintCache()[hash(a.content)];
}

// Lint one artifact (cached by content). Severity 0 = error, 1 = warning.
export async function lintArtifact(a: Pick<SavedArtifact, 'content' | 'format'>): Promise<LintStamp> {
  const key = hash(a.content);
  const cache = loadLintCache();
  if (cache[key]) return cache[key];
  const fmt = a.format || 'openapi';
  const rulesetDef = DEFAULT_RULESETS[fmt] || DEFAULT_RULESETS['openapi'] || {};
  const { lint, Markdown } = await getLintEngine();
  const res = fmt === 'agent-skill'
    ? await lint(a.content, rulesetDef, 'document', Markdown)
    : await lint(a.content, rulesetDef);
  const stamp: LintStamp = {
    errors: res.error ? 1 : res.diagnostics.filter((d) => d.severity === 0).length,
    warnings: res.diagnostics.filter((d) => d.severity === 1).length,
    at: Date.now(),
  };
  cache[key] = stamp;
  // keep the cache bounded
  const keys = Object.keys(cache);
  if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete cache[k];
  saveLintCache(cache);
  return stamp;
}

// Background queue — lint many artifacts without blocking the UI.
let queue: Array<Pick<SavedArtifact, 'content' | 'format'>> = [];
let running = false;
export function enqueueLint(items: Array<Pick<SavedArtifact, 'content' | 'format'>>, onProgress?: () => void) {
  queue.push(...items.filter((a) => !stampFor(a)));
  if (running) return;
  running = true;
  (async () => {
    while (queue.length) {
      const item = queue.shift()!;
      try { await lintArtifact(item); } catch { /* stamp stays absent */ }
      onProgress?.();
      await new Promise((r) => setTimeout(r, 0)); // yield to the UI
    }
    running = false;
    onProgress?.();
  })();
}

// Roll a catalog's stamps up into ✓/⚠/✗ counts (unlinted counts as pending).
export function rollupStamps(members: Array<Pick<SavedArtifact, 'content'>>): { pass: number; warn: number; fail: number; pending: number } {
  const out = { pass: 0, warn: 0, fail: 0, pending: 0 };
  for (const m of members) {
    const s = stampFor(m);
    if (!s) out.pending++;
    else if (s.errors > 0) out.fail++;
    else if (s.warnings > 0) out.warn++;
    else out.pass++;
  }
  return out;
}
