import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  loadArtifacts, upsertArtifact, removeArtifact, getArtifact,
  loadCatalogs, upsertCatalog, removeCatalog, getCatalog,
  upsertCapability, removeCapability, getCapability, capabilitiesForCatalog,
  loadConfig, saveConfig, newId, clearSamples, wasSeeded, markSeeded,
  type SavedArtifact, type Provenance, type Catalog, type Capability, type Config, type ApiProperty, type RecipeStep,
} from './storage';
import { ARTIFACTS, artifactById, type ArtifactType } from './artifacts';
import { searchSource, loadHit, enabledSources, type Hit, type SourceId, type Tokens } from './sources';
import { commitGitHub, openPrGitHub } from './providers';
import { listAccessibleRepos, loadRepos, addRepo, removeRepo, type Repo } from './repos';
import { COMMON_PROPERTIES, propDef, resolveProperties } from './properties';
import { buildCatalogApisJson, detectFormat } from './apisjson-index';
import { buildCatalogOfCatalogs, catalogFileName } from './federation';
import { ageLabel, provKey, regenerateCatalog } from './catalogs';
import { suggestName } from './capabilities';
import { enqueueLint, stampFor, rollupStamps } from './lint-index';
import { embed, cosine, buildApiText } from './semantic';
import { parseHar } from './har';
import { PRESET_SETS, loadPresetSet } from './presets';
import { parseDoc, detectLang, isObject } from './doc';
import { initEngage } from './engage';
import './style.css';

self.MonacoEnvironment = { getWorker: (_id, label) => (label === 'json' ? new JsonWorker() : new EditorWorker()) };
const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

let lang: 'yaml' | 'json' = 'yaml';
let provenance: Provenance = { source: 'manual' };
let activeId: string | null = null; // pool artifact loaded in the editor
let openCatalogId: string | null = null; // catalog drill-in

const editor = monaco.editor.create($('#editor'), {
  value: '', language: 'yaml', theme: 'vs-dark', automaticLayout: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false,
});

// ---- helpers ------------------------------------------------------------------
function downloadFile(name: string, text: string, mime = 'application/yaml') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
const status = (t: string, ok = true) => { const el = $('#save-status'); el.textContent = t; el.style.color = ok ? 'var(--muted)' : '#f14c4c'; };
const membersOf = (c: Catalog): SavedArtifact[] => c.artifactIds.map((id) => getArtifact(id)).filter(Boolean) as SavedArtifact[];
const lintChip = (a: SavedArtifact): string => {
  const s = stampFor(a);
  if (!s) return '<span class="lint-chip pending" title="lint pending">…</span>';
  if (s.errors) return `<span class="lint-chip fail" title="${s.errors} error(s), ${s.warnings} warning(s)">✗ ${s.errors}</span>`;
  if (s.warnings) return `<span class="lint-chip warn" title="${s.warnings} warning(s)">⚠ ${s.warnings}</span>`;
  return '<span class="lint-chip pass" title="no findings">✓</span>';
};
// debounce re-render as background lint stamps land
let lintT: number | undefined;
const onLintProgress = () => { clearTimeout(lintT); lintT = window.setTimeout(() => { renderCatalogs(); renderPool(); }, 400); };

// ---- editor / provenance --------------------------------------------------------
function setContent(text: string) {
  let out = text;
  try { out = lang === 'json' ? JSON.stringify(parseYaml(text), null, 2) : stringifyYaml(parseYaml(text)); } catch { /* keep raw */ }
  const m = editor.getModel();
  if (m) monaco.editor.setModelLanguage(m, lang === 'json' ? 'json' : 'yaml');
  editor.setValue(out);
}
function showProvenance() {
  const p = provenance;
  const where = p.source === 'apis.io' ? `APIs.io${p.aid ? ` · ${p.aid}` : ''}`
    : p.source === 'har' ? 'HAR upload (evidence-based)'
    : p.repo ? `${p.source}: ${p.repo}${p.path ? `/${p.path}` : ''}${p.ref ? ` @ ${p.ref}` : ''}`
    : p.url || p.source;
  $('#provenance').innerHTML = `Source: <strong>${esc(String(where))}</strong>` + (p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">open ↗</a>` : '');
}
$('#lang-yaml').addEventListener('click', () => setLang('yaml'));
$('#lang-json').addEventListener('click', () => setLang('json'));
function setLang(l: 'yaml' | 'json') {
  if (l === lang) return;
  const t = editor.getValue();
  let conv = t; try { conv = l === 'json' ? JSON.stringify(parseYaml(t), null, 2) : stringifyYaml(parseYaml(t)); } catch { /* */ }
  lang = l;
  const m = editor.getModel(); if (m) monaco.editor.setModelLanguage(m, l === 'json' ? 'json' : 'yaml');
  editor.setValue(conv);
  $('#lang-yaml').classList.toggle('active', l === 'yaml');
  $('#lang-json').classList.toggle('active', l === 'json');
}

// ---- artifact type + key-driven source selectors --------------------------------
const typeSelect = $<HTMLSelectElement>('#artifact-type');
typeSelect.innerHTML = ARTIFACTS.map((a) => `<option value="${a.id}">${a.label}</option>`).join('');
typeSelect.value = 'openapi';
let currentArtifact: ArtifactType = artifactById('openapi');
typeSelect.addEventListener('change', () => { currentArtifact = artifactById(typeSelect.value); });

const sourceSelect = $<HTMLSelectElement>('#source');
let currentSource: SourceId = 'apis.io';
function sourceToggles(): Record<string, boolean> {
  const c = loadConfig();
  return {
    'apis.io': true,
    github: !!c.githubToken,
    gitlab: !!c.gitlabToken,
    bitbucket: !!(c.bitbucketUser && c.bitbucketToken),
    swaggerhub: !!c.swaggerhubToken,
    postman: !!c.postmanApiKey,
  };
}
function populateSources() {
  const toggles = sourceToggles();
  const enabled = enabledSources(toggles);
  sourceSelect.innerHTML = enabled.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
  if (!enabled.some((s) => s.id === currentSource)) currentSource = 'apis.io';
  sourceSelect.value = currentSource;
  const st = document.querySelector('#source-status');
  if (st) {
    const labels: Record<string, string> = { 'apis.io': 'APIs.io', github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', swaggerhub: 'SwaggerHub', postman: 'Postman' };
    st.innerHTML = Object.entries(labels).map(([id, label]) =>
      `<span class="src-state ${toggles[id] ? 'on' : 'off'}">${toggles[id] ? '●' : '○'} ${label}</span>`).join('');
  }
}
populateSources();
sourceSelect.addEventListener('change', () => { currentSource = sourceSelect.value as SourceId; });
function gitTokens(): Tokens {
  const c = loadConfig();
  return { github: c.githubToken, gitlab: c.gitlabToken, bitbucketUser: c.bitbucketUser, bitbucket: c.bitbucketToken, swaggerhub: c.swaggerhubToken, postman: c.postmanApiKey };
}

// ---- search + scan ----------------------------------------------------------------
const results = $('#results');
const qInput = $<HTMLInputElement>('#q');
const hideResults = () => { results.hidden = true; results.innerHTML = ''; };
const msg = (t: string) => { results.innerHTML = `<div class="hit-msg">${esc(t)}</div>`; results.hidden = false; };
let lastHits: Hit[] = [];

async function runSearch() {
  const q = qInput.value.trim();
  const srcLabel = sourceSelect.options[sourceSelect.selectedIndex]?.textContent || currentSource;
  msg(`Searching ${srcLabel} for ${currentArtifact.label}…`);
  try {
    lastHits = await searchSource(currentSource, currentArtifact, q, gitTokens());
    if (!lastHits.length) { msg(currentArtifact.searchNote || `No ${currentArtifact.label} results on ${srcLabel}.`); return; }
    results.innerHTML = lastHits.map((h, i) => `<div class="hit" data-i="${i}">
      <span class="hit-name">${esc(h.name)}</span>
      <span class="hit-sub">${esc(h.repo || h.type || h.source)}${h.path ? ` · ${esc(h.path)}` : ''}</span>
    </div>`).join('');
    results.hidden = false;
    results.querySelectorAll<HTMLElement>('.hit').forEach((el) => el.addEventListener('click', () => selectHit(lastHits[Number(el.dataset.i)])));
  } catch (e) {
    msg(`${srcLabel} search failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
async function selectHit(h: Hit) {
  msg(`Loading ${h.name}…`);
  try {
    const content = await loadHit(h, gitTokens());
    provenance = h.source === 'apis.io'
      ? { source: 'apis.io', url: h.url, aid: h.aid } as Provenance
      : { source: h.source as Provenance['source'], repo: h.repo, path: h.path, ref: h.ref, url: h.url };
    activeId = null;
    editorProperties = [];
    $<HTMLInputElement>('#art-name').value = h.name;
    setContent(content);
    showProvenance(); renderProps(); hideResults();
    status('Loaded — Save to pool, then add to a catalog.');
  } catch (e) {
    msg(`Could not load: ${e instanceof Error ? e.message : String(e)}`);
  }
}
$('#search').addEventListener('click', runSearch);
qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
document.addEventListener('click', (e) => { if (!results.hidden && !(e.target as HTMLElement).closest('.search-wrap')) hideResults(); });

// Scan — sweep the source into the pool (deduped by provenance identity).
async function runScan() {
  const srcLabel = sourceSelect.options[sourceSelect.selectedIndex]?.textContent || currentSource;
  const q = qInput.value.trim();
  msg(`Scanning ${srcLabel} for ${currentArtifact.label}…`);
  let hits: Hit[] = [];
  try { hits = await searchSource(currentSource, currentArtifact, q, gitTokens()); }
  catch (e) { msg(`Scan failed: ${e instanceof Error ? e.message : String(e)}`); return; }
  if (!hits.length) { msg(currentArtifact.searchNote || `No ${currentArtifact.label} artifacts found on ${srcLabel}.`); return; }
  const seen = new Set(loadArtifacts().map((a) => provKey(a.provenance)));
  let added = 0, skipped = 0, failed = 0;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const prov: Provenance = h.source === 'apis.io'
      ? { source: 'apis.io', url: h.url, aid: h.aid }
      : { source: h.source as Provenance['source'], repo: h.repo, path: h.path, ref: h.ref, url: h.url };
    if (seen.has(provKey(prov))) { skipped++; continue; }
    msg(`Scanning ${srcLabel}… loading ${i + 1}/${hits.length}: ${h.name}`);
    try {
      const content = await loadHit(h, gitTokens());
      const rec: SavedArtifact = { id: newId(), name: h.name || 'artifact', format: currentArtifact.id, lang: detectLang(content), content, provenance: prov, savedAt: Date.now() };
      upsertArtifact(rec);
      seen.add(provKey(prov));
      added++;
    } catch { failed++; }
  }
  enqueueLint(loadArtifacts(), onLintProgress);
  renderPool(); renderCatalogs(); hideResults(); switchTab('pool');
  status(`Scanned ${srcLabel}: added ${added}${skipped ? ` · skipped ${skipped} already pooled` : ''}${failed ? ` · ${failed} failed` : ''}. Compose a catalog from them →`);
}
$('#scan').addEventListener('click', runScan);

// ---- HAR upload -------------------------------------------------------------------
$<HTMLInputElement>('#har-file').addEventListener('change', async (e) => {
  const files = (e.target as HTMLInputElement).files;
  if (!files?.length) return;
  let added = 0;
  const errs: string[] = [];
  for (const f of Array.from(files)) {
    try {
      for (const api of parseHar(await f.text())) {
        upsertArtifact({
          id: newId(), name: api.host, format: 'openapi', lang: 'yaml', content: api.openapiYaml,
          properties: api.properties, provenance: { source: 'har', url: `https://${api.host}` }, savedAt: Date.now(),
        });
        added++;
      }
    } catch (err) { errs.push(`${f.name}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  (e.target as HTMLInputElement).value = '';
  enqueueLint(loadArtifacts(), onLintProgress);
  renderPool(); switchTab('pool');
  status(`HAR → OpenAPI: added ${added} to the pool${errs.length ? ` · ${errs.length} error(s)` : ''}`, !errs.length);
});

// ---- Import (helper bundle or single spec) ------------------------------------------
$<HTMLInputElement>('#import-file').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f) return;
  const text = await f.text();
  const doc = parseDoc(text);
  if (isObject(doc) && Array.isArray(doc.apis) && doc.apis.some((a: any) => a.openapi)) {
    let n = 0;
    for (const a of doc.apis) {
      if (!a.openapi) continue;
      const content = typeof a.openapi === 'string' ? a.openapi : stringifyYaml(a.openapi);
      upsertArtifact({
        id: newId(), name: a.name || 'imported', format: detectFormat(content), lang: a.lang === 'json' ? 'json' : 'yaml',
        content, properties: Array.isArray(a.properties) ? a.properties : undefined,
        apisjson: a.apisjson ? (typeof a.apisjson === 'string' ? a.apisjson : stringifyYaml(a.apisjson)) : undefined,
        provenance: a.provenance || { source: 'helper', gateway: a.gateway }, savedAt: Date.now(),
      });
      n++;
    }
    enqueueLint(loadArtifacts(), onLintProgress);
    renderPool(); switchTab('pool');
    status(`Imported ${n} artifact${n === 1 ? '' : 's'} into the pool.`);
    return;
  }
  lang = detectLang(text);
  provenance = { source: 'url', url: f.name };
  activeId = null;
  editorProperties = [];
  $<HTMLInputElement>('#art-name').value = (doc?.info?.title || f.name).toString();
  $('#lang-yaml').classList.toggle('active', lang === 'yaml'); $('#lang-json').classList.toggle('active', lang === 'json');
  setContent(text);
  showProvenance(); renderProps();
  status('Loaded file — Save to pool, then add to a catalog.');
});

// ---- properties panel ----------------------------------------------------------------
let editorProperties: ApiProperty[] = [];
const propTypeSelect = $<HTMLSelectElement>('#prop-type');
propTypeSelect.innerHTML = COMMON_PROPERTIES.map((p) => `<option value="${p.type}" title="${esc(p.help)}">${esc(p.label)}</option>`).join('');
function renderProps() {
  const chips = $('#prop-chips');
  chips.innerHTML = editorProperties.length
    ? editorProperties.map((p, i) => `<span class="prop-chip" data-i="${i}"><span class="prop-t">${esc(propDef(p.type)?.label || p.type)}</span>${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.url)}">↗</a>` : ''}<button class="prop-x" type="button" title="Remove">&times;</button></span>`).join('')
    : '<span class="muted small">No properties yet — add Documentation, Sandbox, MCP…</span>';
  chips.querySelectorAll<HTMLElement>('.prop-chip').forEach((el) => {
    el.querySelector<HTMLButtonElement>('.prop-x')?.addEventListener('click', () => {
      editorProperties.splice(Number(el.dataset.i), 1);
      persistProps(); renderProps();
    });
  });
}
function persistProps() {
  if (!activeId) return;
  const rec = getArtifact(activeId);
  if (rec) { rec.properties = [...editorProperties]; delete rec.apisjson; upsertArtifact(rec); renderPool(); }
}
$('#prop-add').addEventListener('click', () => {
  const type = propTypeSelect.value;
  const url = $<HTMLInputElement>('#prop-url').value.trim();
  if (!type) return;
  const existing = editorProperties.find((p) => p.type === type);
  if (existing) existing.url = url;
  else editorProperties.push({ type, url });
  $<HTMLInputElement>('#prop-url').value = '';
  persistProps(); renderProps();
});
$<HTMLInputElement>('#prop-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#prop-add').click(); });

// ---- savebar: save to pool + add to catalog --------------------------------------------
function populateCatalogSelect() {
  const sel = $<HTMLSelectElement>('#add-cat-select');
  const cats = loadCatalogs();
  const prev = sel.value;
  sel.innerHTML = cats.length ? cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('') : '<option value="">— no catalogs yet —</option>';
  if (cats.some((c) => c.id === prev)) sel.value = prev;
}
$('#save-pool').addEventListener('click', () => {
  const content = editor.getValue().trim();
  if (!content) { status('Nothing to save — load or paste an artifact first.', false); return; }
  const name = $<HTMLInputElement>('#art-name').value.trim() || parseDoc(content)?.info?.title || 'Untitled';
  const rec: SavedArtifact = activeId && getArtifact(activeId)
    ? { ...getArtifact(activeId)!, name, lang, content, properties: [...editorProperties], savedAt: Date.now() }
    : { id: newId(), name, format: detectFormat(content), lang, content, properties: [...editorProperties], provenance, savedAt: Date.now() };
  activeId = rec.id;
  upsertArtifact(rec);
  enqueueLint([rec], onLintProgress);
  renderPool(); renderCatalogs();
  status('Saved to pool ✓');
});
$('#add-cat-btn').addEventListener('click', () => {
  const catId = $<HTMLSelectElement>('#add-cat-select').value;
  if (!catId) { status('Create a catalog first (Catalogs tab).', false); return; }
  if (!activeId) { status('Save to pool first, then add to a catalog.', false); return; }
  const c = getCatalog(catId);
  if (!c) return;
  if (!c.artifactIds.includes(activeId)) { c.artifactIds.push(activeId); c.modifiedAt = Date.now(); upsertCatalog(c); }
  renderCatalogs();
  status(`Added to “${c.name}” ✓`);
});

// ---- example sets ------------------------------------------------------------------
const setSelect = $<HTMLSelectElement>('#sample-set');
setSelect.innerHTML = PRESET_SETS.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
async function seedSet(setId: string) {
  const set = PRESET_SETS.find((s) => s.id === setId);
  if (!set) return;
  status(`Loading “${set.label}”…`);
  let items;
  try { items = await loadPresetSet(setId); }
  catch (e) { status(`Could not load ${set.label}: ${e instanceof Error ? e.message : String(e)}`, false); return; }

  const seen = new Set(loadArtifacts().map((a) => provKey(a.provenance)));
  const orgIds = new Map<string, string[]>(); // org -> new artifact ids
  const allIds: string[] = [];
  for (const s of items) {
    const prov: Provenance = { source: 'sample', url: `preset:${setId}:${s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` };
    if (seen.has(provKey(prov))) continue;
    const rec: SavedArtifact = { id: newId(), name: s.name, format: 'openapi', lang: 'yaml', content: s.openapi, properties: s.properties, provenance: prov, savedAt: Date.now() };
    upsertArtifact(rec);
    seen.add(provKey(prov));
    allIds.push(rec.id);
    const org = s.grouping?.org || set.label.split(' — ')[0];
    (orgIds.get(org) || orgIds.set(org, []).get(org)!).push(rec.id);
  }
  // One catalog per org in the set — many views from one load. For the demo set
  // that's Acme + Globex; for a provider set it's one catalog for the provider.
  const now = Date.now();
  let created = 0;
  for (const [org, ids] of orgIds) {
    if (!ids.length) continue;
    upsertCatalog({
      id: newId(), name: `${org} APIs`, scope: { org }, artifactIds: ids,
      recipe: { steps: [{ kind: 'set', setId } as RecipeStep] }, createdAt: now, modifiedAt: now,
    });
    created++;
  }
  markSeeded();
  enqueueLint(loadArtifacts(), onLintProgress);
  populateCatalogSelect(); renderCatalogs(); renderPool(); updateSamplesBar();
  status(`Loaded ${allIds.length} artifact${allIds.length === 1 ? '' : 's'} → ${created} catalog${created === 1 ? '' : 's'} created.`);
}
function updateSamplesBar() {
  const n = loadArtifacts().filter((a) => a.provenance.source === 'sample').length;
  ($('#clear-samples') as HTMLButtonElement).disabled = n === 0;
  $('#samples-note').textContent = n ? `${n} example artifact${n === 1 ? '' : 's'} in the pool.` : 'No examples loaded — pick a set and Add.';
}
$('#add-set').addEventListener('click', () => seedSet(setSelect.value));
$('#clear-samples').addEventListener('click', () => {
  clearSamples();
  // drop now-empty example catalogs
  for (const c of loadCatalogs()) if (c.artifactIds.length === 0 && c.recipe?.steps.some((s) => s.kind === 'set')) removeCatalog(c.id);
  if (activeId && !getArtifact(activeId)) activeId = null;
  populateCatalogSelect(); renderCatalogs(); renderPool(); updateSamplesBar();
  status('Cleared example artifacts.');
});

// ---- compose: new catalog / semantic compose ----------------------------------------
$('#new-cat-btn').addEventListener('click', () => {
  const name = $<HTMLInputElement>('#new-cat-name').value.trim();
  if (!name) return;
  const now = Date.now();
  upsertCatalog({ id: newId(), name, scope: {}, artifactIds: [], createdAt: now, modifiedAt: now });
  $<HTMLInputElement>('#new-cat-name').value = '';
  populateCatalogSelect(); renderCatalogs();
});
async function composeFromIntent() {
  const intent = $<HTMLInputElement>('#compose-intent').value.trim();
  if (!intent) return;
  const pool = loadArtifacts();
  if (pool.length < 2) { status('Load or discover some artifacts first.', false); return; }
  status('Composing — matching the pool by meaning…');
  try {
    const texts = pool.map((a) => buildApiText(a.name, a.content, []));
    const vecs = await embed(texts, (m) => status(m));
    const [q] = await embed([intent]);
    const TH = 0.35;
    const ids = pool.filter((_, i) => cosine(q, vecs[i]) >= TH).map((a) => a.id);
    if (!ids.length) { status(`No matches for “${intent}” — nothing like that in the pool yet.`, false); return; }
    const now = Date.now();
    const cat: Catalog = {
      id: newId(), name: intent, description: `Composed by intent: “${intent}”.`,
      scope: { category: intent }, artifactIds: ids,
      recipe: { steps: [{ kind: 'semantic', query: intent, threshold: TH }] },
      createdAt: now, modifiedAt: now,
    };
    upsertCatalog(cat);
    $<HTMLInputElement>('#compose-intent').value = '';
    openCatalogId = cat.id;
    populateCatalogSelect(); renderCatalogs();
    status(`Composed “${intent}” — ${ids.length} artifact${ids.length === 1 ? '' : 's'}. Recipe recorded; regenerate anytime.`);
  } catch (e) { status(`Compose failed: ${e instanceof Error ? e.message : String(e)}`, false); }
}
$('#compose-btn').addEventListener('click', composeFromIntent);
$<HTMLInputElement>('#compose-intent').addEventListener('keydown', (e) => { if (e.key === 'Enter') composeFromIntent(); });

// ---- catalogs tab (list + drill-in detail) ------------------------------------------
function scopeChips(c: Catalog): string {
  return (['org', 'team', 'domain', 'category'] as const)
    .filter((k) => c.scope[k])
    .map((k) => `<span class="scope-chip">${k}: ${esc(c.scope[k]!)}</span>`).join('');
}
function renderCatalogs() {
  const cats = loadCatalogs();
  $('#cat-count').textContent = String(cats.length);
  const body = $('#catalogs-body');
  if (openCatalogId) { renderCatalogDetail(body); return; }
  if (!cats.length) {
    body.innerHTML = '<p class="store-empty">No catalogs yet. Load an example set, 🧠 Compose one by purpose, or create one with New. Catalogs are cheap — make one per team, domain, project, or agent, and throw them away when done.</p>';
    return;
  }
  body.innerHTML = cats.map((c) => {
    const members = membersOf(c);
    const fresh = ageLabel(c.modifiedAt);
    const roll = rollupStamps(members);
    return `<div class="cap-card cat-card" data-id="${c.id}">
      <div class="cap-head">
        <span class="cap-name">${esc(c.name)}</span>
        ${scopeChips(c)}
        <span class="cap-badge">${members.length} API${members.length === 1 ? '' : 's'}</span>
        <span class="fresh-badge ${fresh.cls}" title="last composed/regenerated">${fresh.label}</span>
        <span class="lint-roll" title="lint: pass / warn / fail${roll.pending ? ` (${roll.pending} pending)` : ''}">✓${roll.pass} ⚠${roll.warn} ✗${roll.fail}</span>
      </div>
      <div class="cap-assign cat-actions">
        <button class="cat-open btn-accent" type="button">Open</button>
        ${c.recipe?.steps.length ? '<button class="cat-regen" type="button" title="Re-run this catalog\'s recipe against the live sources">Regenerate</button>' : ''}
        <button class="cat-export" type="button" title="Download this catalog as APIs.json (YAML)">APIs.json</button>
        <button class="cat-del" type="button" title="Delete the catalog (pool artifacts are kept)">Delete</button>
      </div>
    </div>`;
  }).join('');
  body.querySelectorAll<HTMLElement>('.cat-card').forEach((card) => {
    const id = card.dataset.id!;
    card.querySelector<HTMLButtonElement>('.cat-open')?.addEventListener('click', () => { openCatalogId = id; renderCatalogs(); });
    card.querySelector<HTMLButtonElement>('.cat-export')?.addEventListener('click', () => exportCatalog(id));
    card.querySelector<HTMLButtonElement>('.cat-regen')?.addEventListener('click', () => regen(id));
    card.querySelector<HTMLButtonElement>('.cat-del')?.addEventListener('click', () => {
      const c = getCatalog(id);
      if (c && window.confirm(`Delete catalog “${c.name}”? Its artifacts stay in the pool.`)) {
        removeCatalog(id);
        if (openCatalogId === id) openCatalogId = null;
        populateCatalogSelect(); renderCatalogs();
      }
    });
  });
}

function exportCatalog(id: string) {
  const c = getCatalog(id);
  if (!c) return;
  downloadFile(catalogFileName(c), buildCatalogApisJson(c, loadArtifacts()));
}
async function regen(id: string) {
  const c = getCatalog(id);
  if (!c) return;
  status(`Regenerating “${c.name}”…`);
  try {
    const r = await regenerateCatalog(c, gitTokens(), (m) => status(m));
    enqueueLint(loadArtifacts(), onLintProgress);
    renderCatalogs(); renderPool();
    status(`Regenerated “${c.name}”: +${r.added} new, ${r.attached} attached, ${r.kept} kept${r.failed ? `, ${r.failed} failed` : ''}.`);
  } catch (e) { status(`Regenerate failed: ${e instanceof Error ? e.message : String(e)}`, false); }
}

// ---- catalog detail ----------------------------------------------------------------
function renderCatalogDetail(body: HTMLElement) {
  const c = openCatalogId ? getCatalog(openCatalogId) : undefined;
  if (!c) { openCatalogId = null; renderCatalogs(); return; }
  const members = membersOf(c);
  const caps = capabilitiesForCatalog(c.id);
  const fresh = ageLabel(c.modifiedAt);
  const poolRest = loadArtifacts().filter((a) => !c.artifactIds.includes(a.id));
  const nameOf = (id: string) => getArtifact(id)?.name || '?';

  body.innerHTML = `
    <p><a href="#" id="cat-back">← All catalogs</a></p>
    <div class="cap-head" style="border:none;padding:0 0 0.4rem 0;background:none">
      <span class="cap-name" style="font-size:1.05rem">${esc(c.name)}</span>
      ${scopeChips(c)}
      <span class="fresh-badge ${fresh.cls}">${fresh.label}</span>
    </div>
    ${c.description ? `<p class="src-note">${esc(c.description)}</p>` : ''}
    ${c.recipe?.steps.length ? `<p class="src-note">Recipe: ${c.recipe.steps.map((s) => `<code>${esc(s.kind)}${s.query ? ` “${esc(s.query)}”` : ''}${s.source ? ` @ ${esc(s.source)}` : ''}${s.setId ? ` (${esc(s.setId)})` : ''}</code>`).join(' + ')} — <a href="#" id="cat-regen-d">regenerate</a></p>` : ''}
    <div class="repos-add" style="padding:0.4rem 0">
      <button id="cat-export-d" class="btn-accent" type="button">Download APIs.json</button>
      <select id="cat-repo-select"></select>
      <button id="cat-commit" type="button" title="Commit this catalog's APIs.json to the selected repo">Commit ↗</button>
      <button id="cat-pr" type="button" title="Open a PR with this catalog's APIs.json">PR ↗</button>
    </div>
    <h3>Members (${members.length})</h3>
    <ul class="cap-members">
      ${members.map((m) => `<li data-api="${m.id}">
        ${lintChip(m)}
        <span class="store-name">${esc(m.name)}</span>
        <span class="muted small">${esc(m.format || '')}</span>
        <button class="mem-load cap-canon" type="button" title="Open in the editor">open</button>
        <button class="mem-remove cap-remove" type="button" title="Remove from this catalog (stays in pool)">&times;</button>
      </li>`).join('') || '<li class="store-empty">Empty — add from the pool below.</li>'}
    </ul>
    <div class="cap-assign">
      <select id="cat-add-select">${poolRest.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('') || '<option value="">— everything is in this catalog —</option>'}</select>
      <button id="cat-add-member" type="button">Add from pool</button>
    </div>
    <h3>Capabilities <span class="muted small">(${caps.length})</span> <button id="cap-suggest" class="cap-canon" type="button" title="Cluster this catalog's members by meaning into suggested capabilities">🧠 Suggest</button></h3>
    ${caps.map((cap) => `<div class="cap-card" data-cap="${cap.id}">
      <div class="cap-head">
        <span class="cap-name">${esc(cap.name)}</span>
        <span class="cap-badge">${cap.apiIds.length} impl${cap.apiIds.length === 1 ? '' : 's'}</span>
        <button class="cap-del" type="button">Delete</button>
      </div>
      <ul class="cap-members">
        ${cap.apiIds.map((id) => `<li data-api="${id}">
          <span class="store-name">${cap.canonicalId === id ? '★ ' : ''}${esc(nameOf(id))}</span>
          <button class="capm-canon cap-canon${cap.canonicalId === id ? ' on' : ''}" type="button">${cap.canonicalId === id ? 'canonical' : 'make canonical'}</button>
          <button class="capm-remove cap-remove" type="button">&times;</button>
        </li>`).join('')}
      </ul>
      <div class="cap-assign">
        <select class="capm-add-select">${c.artifactIds.filter((id) => !cap.apiIds.includes(id)).map((id) => `<option value="${id}">${esc(nameOf(id))}</option>`).join('') || '<option value="">— all members assigned —</option>'}</select>
        <button class="capm-add" type="button">Assign member</button>
      </div>
    </div>`).join('')}
    <div class="cap-assign" style="padding-left:0">
      <input id="new-cap-name" placeholder="new capability name" autocomplete="off" style="flex:1;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:5px;padding:4px 8px" />
      <button id="new-cap-btn" type="button">Add capability</button>
    </div>
  `;

  $('#cat-back').addEventListener('click', (e) => { e.preventDefault(); openCatalogId = null; renderCatalogs(); });
  $('#cat-export-d').addEventListener('click', () => exportCatalog(c.id));
  document.querySelector('#cat-regen-d')?.addEventListener('click', (e) => { e.preventDefault(); regen(c.id); });
  // repo select for commit/PR
  const repoSel = $<HTMLSelectElement>('#cat-repo-select');
  const repos = loadRepos();
  repoSel.innerHTML = repos.length ? repos.map((r) => `<option value="${esc(r.fullName)}">${esc(r.fullName)}</option>`).join('') : '<option value="">— add repos in Repos tab —</option>';
  const gitCatalog = async (kind: 'commit' | 'pr') => {
    const cfg = loadConfig();
    if (!cfg.githubToken) return status('Add a GitHub token in Config.', false);
    const repo = repoSel.value || cfg.defaultRepo;
    if (!repo) return status('Pick a repo (Repos tab) or set a default in Config.', false);
    const path = window.prompt('File path in the repo:', catalogFileName(c));
    if (!path) return;
    const branch = repos.find((r) => r.fullName === repo)?.defaultBranch || cfg.defaultBranch || 'main';
    const message = `${kind === 'pr' ? 'Propose' : 'Update'} ${path} via API Discovery`;
    status(kind === 'pr' ? 'Opening PR…' : 'Committing…');
    try {
      const yaml = buildCatalogApisJson(c, loadArtifacts());
      const url = kind === 'pr' ? await openPrGitHub(repo, path, yaml, message, branch, cfg) : await commitGitHub(repo, path, yaml, message, branch, cfg);
      const el = $('#save-status'); el.innerHTML = `${kind === 'pr' ? 'PR opened' : 'Committed'} ✓ <a href="${esc(url)}" target="_blank" rel="noopener">open ↗</a>`;
    } catch (e) { status(`${kind} failed: ${e instanceof Error ? e.message : String(e)}`, false); }
  };
  $('#cat-commit').addEventListener('click', () => gitCatalog('commit'));
  $('#cat-pr').addEventListener('click', () => gitCatalog('pr'));

  // members
  body.querySelectorAll<HTMLLIElement>('ul.cap-members li[data-api]').forEach((li) => {
    const apiId = li.dataset.api!;
    li.querySelector<HTMLButtonElement>('.mem-load')?.addEventListener('click', () => loadIntoEditor(apiId));
    li.querySelector<HTMLButtonElement>('.mem-remove')?.addEventListener('click', () => {
      c.artifactIds = c.artifactIds.filter((x) => x !== apiId);
      c.modifiedAt = Date.now();
      upsertCatalog(c);
      for (const cap of capabilitiesForCatalog(c.id)) {
        if (cap.apiIds.includes(apiId)) { cap.apiIds = cap.apiIds.filter((x) => x !== apiId); if (cap.canonicalId === apiId) cap.canonicalId = undefined; upsertCapability(cap); }
      }
      renderCatalogs();
    });
  });
  $('#cat-add-member').addEventListener('click', () => {
    const id = $<HTMLSelectElement>('#cat-add-select').value;
    if (!id) return;
    if (!c.artifactIds.includes(id)) { c.artifactIds.push(id); c.modifiedAt = Date.now(); upsertCatalog(c); }
    renderCatalogs();
  });

  // capabilities
  $('#new-cap-btn').addEventListener('click', () => {
    const name = $<HTMLInputElement>('#new-cap-name').value.trim();
    if (!name) return;
    upsertCapability({ id: newId(), catalogId: c.id, name, apiIds: [], createdAt: Date.now() });
    renderCatalogs();
  });
  $('#cap-suggest').addEventListener('click', () => suggestCapabilitiesFor(c));
  body.querySelectorAll<HTMLElement>('.cap-card[data-cap]').forEach((card) => {
    const capId = card.dataset.cap!;
    const mutate = (fn: (x: Capability) => void) => { const cap = getCapability(capId); if (!cap) return; fn(cap); upsertCapability(cap); renderCatalogs(); };
    card.querySelector<HTMLButtonElement>('.cap-del')?.addEventListener('click', () => { removeCapability(capId); renderCatalogs(); });
    card.querySelector<HTMLButtonElement>('.capm-add')?.addEventListener('click', () => {
      const id = card.querySelector<HTMLSelectElement>('.capm-add-select')!.value;
      if (id) mutate((cap) => { if (!cap.apiIds.includes(id)) cap.apiIds.push(id); });
    });
    card.querySelectorAll<HTMLLIElement>('li[data-api]').forEach((li) => {
      const apiId = li.dataset.api!;
      li.querySelector<HTMLButtonElement>('.capm-canon')?.addEventListener('click', () => mutate((cap) => { cap.canonicalId = apiId; }));
      li.querySelector<HTMLButtonElement>('.capm-remove')?.addEventListener('click', () => mutate((cap) => { cap.apiIds = cap.apiIds.filter((x) => x !== apiId); if (cap.canonicalId === apiId) cap.canonicalId = undefined; }));
    });
  });
}

// Cluster a catalog's members by meaning into suggested capabilities.
async function suggestCapabilitiesFor(c: Catalog) {
  const members = membersOf(c);
  if (members.length < 2) { status('Add at least two members first.', false); return; }
  status('Clustering members by meaning…');
  try {
    const texts = members.map((a) => buildApiText(a.name, a.content, []));
    const vecs = await embed(texts, (m) => status(m));
    const assigned = new Set(capabilitiesForCatalog(c.id).flatMap((x) => x.apiIds));
    const TH = 0.7, used = new Set<number>();
    let created = 0;
    for (let i = 0; i < members.length; i++) {
      if (used.has(i) || assigned.has(members[i].id)) continue;
      const cluster = [i];
      for (let j = 0; j < members.length; j++) {
        if (j === i || used.has(j) || assigned.has(members[j].id)) continue;
        if (cosine(vecs[i], vecs[j]) >= TH) cluster.push(j);
      }
      if (cluster.length < 2) continue;
      cluster.forEach((k) => used.add(k));
      upsertCapability({
        id: newId(), catalogId: c.id,
        name: suggestName(cluster.map((k) => members[k].name)),
        apiIds: cluster.map((k) => members[k].id),
        canonicalId: members[cluster[0]].id,
        createdAt: Date.now(),
      });
      created++;
    }
    renderCatalogs();
    status(created ? `Suggested ${created} capabilit${created === 1 ? 'y' : 'ies'} — rename and set canonicals as needed.` : 'No clusters found (members too dissimilar or already assigned).');
  } catch (e) { status(`Suggest failed: ${e instanceof Error ? e.message : String(e)}`, false); }
}

// ---- pool tab ---------------------------------------------------------------------
function loadIntoEditor(id: string) {
  const a = getArtifact(id);
  if (!a) return;
  activeId = a.id; lang = a.lang; provenance = a.provenance;
  editorProperties = resolveProperties(a).map((p) => ({ ...p }));
  $('#lang-yaml').classList.toggle('active', lang === 'yaml'); $('#lang-json').classList.toggle('active', lang === 'json');
  $<HTMLInputElement>('#art-name').value = a.name;
  const m = editor.getModel(); if (m) monaco.editor.setModelLanguage(m, lang === 'json' ? 'json' : 'yaml');
  editor.setValue(a.content);
  showProvenance(); renderProps(); renderPool();
}
function renderPool() {
  const all = loadArtifacts().sort((a, b) => b.savedAt - a.savedAt);
  $('#pool-count').textContent = String(all.length);
  const filter = $<HTMLInputElement>('#pool-filter').value.trim().toLowerCase();
  const cats = loadCatalogs();
  const inCats = (id: string) => cats.filter((c) => c.artifactIds.includes(id)).map((c) => c.name);
  const shown = filter ? all.filter((a) => `${a.name} ${a.format} ${a.provenance.source}`.toLowerCase().includes(filter)) : all;
  const list = $('#pool-list');
  list.innerHTML = shown.length
    ? shown.map((a) => {
        const memberOf = inCats(a.id);
        return `<li class="${a.id === activeId ? 'active' : ''}" data-id="${a.id}">
          ${lintChip(a)}
          <span class="store-name" title="${esc(a.name)}">${esc(a.name)}</span>
          <span class="store-meta">${esc(a.format || '')} · ${esc(a.provenance.source)}${memberOf.length ? ` · in ${memberOf.map(esc).join(', ')}` : ' · in no catalog'}</span>
          <button class="store-btn" type="button">Load</button>
          <button class="store-del" type="button" title="Remove from the pool (and every catalog)">&times;</button>
        </li>`;
      }).join('')
    : `<li class="store-empty">${filter ? 'No matches.' : 'Pool is empty — search, Scan, upload a HAR, or load an example set.'}</li>`;
  list.querySelectorAll<HTMLLIElement>('li[data-id]').forEach((li) => {
    const id = li.dataset.id!;
    li.querySelector<HTMLButtonElement>('.store-btn')?.addEventListener('click', () => loadIntoEditor(id));
    li.querySelector<HTMLButtonElement>('.store-del')?.addEventListener('click', () => {
      removeArtifact(id);
      if (id === activeId) activeId = null;
      renderPool(); renderCatalogs(); populateCatalogSelect(); updateSamplesBar();
    });
  });
}
$<HTMLInputElement>('#pool-filter').addEventListener('input', renderPool);
$('#pool-clear').addEventListener('click', () => { $<HTMLInputElement>('#pool-filter').value = ''; renderPool(); });

// ---- repos tab ---------------------------------------------------------------------
let accessibleRepos: Repo[] = [];
async function loadAccessibleRepos() {
  const token = loadConfig().githubToken;
  const picker = $<HTMLSelectElement>('#repo-picker');
  if (!token) { picker.innerHTML = '<option value="">Add a GitHub token in Config →</option>'; return; }
  picker.innerHTML = '<option value="">Loading your repos…</option>';
  try {
    accessibleRepos = await listAccessibleRepos(token);
    const saved = new Set(loadRepos().map((r) => r.fullName));
    const avail = accessibleRepos.filter((r) => !saved.has(r.fullName));
    picker.innerHTML = avail.length
      ? avail.map((r) => `<option value="${esc(r.fullName)}">${esc(r.fullName)}${r.private ? ' (private)' : ''}</option>`).join('')
      : '<option value="">All accessible repos already added</option>';
  } catch (e) {
    picker.innerHTML = `<option value="">${esc(e instanceof Error ? e.message : 'Could not load repos')}</option>`;
  }
}
function renderRepos() {
  const repos = loadRepos();
  $('#repos-count').textContent = String(repos.length);
  const list = $('#repos-list');
  list.innerHTML = repos.length
    ? repos.map((r) => `<li data-name="${esc(r.fullName)}">
        <span class="store-name" title="${esc(r.fullName)}">${esc(r.fullName)}</span>
        <span class="store-meta">${r.private ? 'private' : 'public'} · ${esc(r.defaultBranch)}</span>
        <button class="store-del" type="button" title="Remove">&times;</button>
      </li>`).join('')
    : '<li class="store-empty">No repos yet — pick one above and Add.</li>';
  list.querySelectorAll<HTMLLIElement>('li[data-name]').forEach((li) => {
    li.querySelector<HTMLButtonElement>('.store-del')?.addEventListener('click', () => {
      removeRepo(li.dataset.name!); renderRepos(); loadAccessibleRepos();
    });
  });
}
$('#repo-add').addEventListener('click', () => {
  const full = $<HTMLSelectElement>('#repo-picker').value;
  if (!full) return;
  addRepo(accessibleRepos.find((x) => x.fullName === full) ?? { fullName: full, defaultBranch: 'main', private: false });
  renderRepos(); loadAccessibleRepos();
});
$('#repo-refresh').addEventListener('click', loadAccessibleRepos);

// ---- about --------------------------------------------------------------------------
function renderAbout() {
  $('#about-body').innerHTML = `
    <h2>Catalogs are views, not databases</h2>
    <p><strong>API Discovery</strong> is built on a simple statement: <em>API catalogs are relative to domains, teams, categories, and purposes — and they are ephemeral and ever-changing, not static central catalogs.</em> The multi-year, single-source-of-truth catalog project keeps failing because it fights how organizations actually work. This tool goes the other way: make catalogs so cheap to compose, regenerate, and throw away that you stop needing the monolith.</p>

    <h3>How it works</h3>
    <ol>
      <li><strong>Discover</strong> into the <strong>pool</strong> — search or Scan APIs.io, GitHub/GitLab/Bitbucket, SwaggerHub, Postman (sources appear as you add keys); upload HAR traffic captures; or Import a bundle from the <a href="https://github.com/api-commons/api-reusability/tree/main/helper" target="_blank" rel="noopener">enterprise helper CLI</a> (Backstage, gateways, Kubernetes, Kafka…).</li>
      <li><strong>Compose catalogs</strong> — named, purpose-scoped views over the pool: per team, per domain, per project, per agent. Type an intent (<em>“everything payments”</em>) and <strong>🧠 Compose</strong> semantic-matches the pool into a catalog. The same API can live in many catalogs; deleting a catalog deletes nothing.</li>
      <li><strong>Regenerate</strong> — every composed catalog carries its <strong>recipe</strong> (the queries that built it) and can be rebuilt against live sources anytime. Freshness is displayed, not hidden: a catalog is a build artifact, not a database.</li>
      <li><strong>Trust travels with the catalog</strong> — every artifact is linted on entry (Spotlight engine, in-browser) and stamped ✓/⚠/✗; catalogs roll the stamps up. Deep rule editing lives in <a href="https://validator.spotlight-rules.com" target="_blank" rel="noopener">Spotlight Validator</a>.</li>
      <li><strong>Capabilities</strong> — inside any catalog, cluster members into named business capabilities (🧠 Suggest), pick canonicals, and ship the capability map in the export.</li>
      <li><strong>Publish &amp; federate</strong> — download any catalog as APIs.json (YAML), commit/PR it to a repo, and export a <strong>catalog of catalogs</strong>: a lightweight APIs.json <code>includes</code> index linking all your purpose-built catalogs — federation instead of centralization.</li>
    </ol>

    <h3>Getting started</h3>
    <p>Load the <strong>demo org</strong> set (25 synthetic APIs — it creates two org catalogs from one pool immediately) or any of the <strong>50+ real provider sets</strong> (Stripe, Twilio, GitHub, Claude… served by the <a href="https://reusability.apicommons.org" target="_blank" rel="noopener">API Reusability</a> project). Then 🧠 Compose a catalog by intent and watch the same artifacts appear in multiple views.</p>

    <p class="src-note">Part of the <a href="https://apicommons.org" target="_blank" rel="noopener">API Commons</a> family: <a href="https://reusability.apicommons.org" target="_blank" rel="noopener">API Reusability</a> judges how reusable your APIs are; API Discovery composes them into catalogs; <a href="https://validator.spotlight-rules.com" target="_blank" rel="noopener">Spotlight Validator</a> lints them deeply. Everything runs in your browser — no backend, keys stay local.</p>
  `;
}

// ---- tabs ---------------------------------------------------------------------------
function switchTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  for (const id of ['catalogs', 'pool', 'repos', 'about', 'config']) ($('#tab-' + id) as HTMLElement).hidden = id !== name;
  if (name === 'catalogs') renderCatalogs();
  if (name === 'pool') renderPool();
  if (name === 'repos') { renderRepos(); loadAccessibleRepos(); }
  if (name === 'about') renderAbout();
}
document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab!)));

// ---- config -------------------------------------------------------------------------
const CFG_MAP: Array<[string, keyof Config]> = [
  ['cfg-gh-token', 'githubToken'], ['cfg-gh-repo', 'defaultRepo'], ['cfg-gh-branch', 'defaultBranch'],
  ['cfg-gl-token', 'gitlabToken'], ['cfg-bb-user', 'bitbucketUser'], ['cfg-bb-token', 'bitbucketToken'],
  ['cfg-swaggerhub-token', 'swaggerhubToken'], ['cfg-postman-key', 'postmanApiKey'],
  ['cfg-fed-base', 'federationBaseUrl'],
];
(function initConfig() {
  const cfg = loadConfig();
  for (const [id, key] of CFG_MAP) {
    const el = $<HTMLInputElement>('#' + id);
    el.value = (cfg[key] as string) ?? '';
    let t: number | undefined;
    el.addEventListener('input', () => {
      clearTimeout(t);
      t = window.setTimeout(() => {
        const c = loadConfig(); const v = el.value.trim();
        if (v) (c[key] as string) = v; else delete c[key];
        saveConfig(c);
        populateSources();
      }, 300);
    });
  }
  $<HTMLInputElement>('#cfg-show').addEventListener('change', (e) => {
    const type = (e.target as HTMLInputElement).checked ? 'text' : 'password';
    for (const id of ['cfg-gh-token', 'cfg-gl-token', 'cfg-bb-token', 'cfg-swaggerhub-token', 'cfg-postman-key']) $<HTMLInputElement>('#' + id).type = type;
  });
})();

// ---- federation download ---------------------------------------------------------------
$('#download-federation').addEventListener('click', () => {
  const cats = loadCatalogs();
  if (!cats.length) { window.alert('No catalogs yet — compose some first.'); return; }
  downloadFile('apis.yaml', buildCatalogOfCatalogs(cats, loadConfig().federationBaseUrl));
});

// ---- boot ---------------------------------------------------------------------------
if (loadArtifacts().length === 0 && !wasSeeded()) {
  seedSet('sample'); // async — renders when done
} else {
  renderCatalogs(); renderPool();
  enqueueLint(loadArtifacts(), onLintProgress);
}
populateCatalogSelect();
updateSamplesBar();
renderProps();
showProvenance();

initEngage(() => {
  const parts = [`Pool: ${loadArtifacts().length} artifacts`, `Catalogs: ${loadCatalogs().length}`];
  return 'Context from API Discovery:\n- ' + parts.join('\n- ');
});
