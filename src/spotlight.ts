// In-browser linting with the Spotlight engine. We construct a Ruleset directly
// from a ruleset definition object, resolving `spotlight:*` string extends to the
// built-in ruleset objects (no in-browser bundler / fs needed).
import { Spotlight, Document, Ruleset } from '@spotlight-rules/spotlight-core';
import type { RulesetDefinition, IRuleResult } from '@spotlight-rules/spotlight-core';
import * as Parsers from '@spotlight-rules/spotlight-parsers';
import { oas, asyncapi, arazzo } from '@spotlight-rules/spotlight-rulesets';
import * as fmts from '@spotlight-rules/spotlight-formats';
import * as skillFunctions from './skill-functions';

// Built-in + agent-skill custom functions, keyed by the name a data-form ruleset
// references in `then.function`. (Discovery ships only the tiny per-type default
// rulesets — the curated compiled catalog stays in Spotlight Validator.)
const FN_MAP: Record<string, unknown> = { ...skillFunctions };

const BUILTIN_RULESETS: Record<string, unknown> = {
  'spotlight:oas': oas,
  'spotlight:asyncapi': asyncapi,
  'spotlight:arazzo': arazzo,
};

// Rule descriptions from the built-in rulesets, so the UI can show a tooltip for
// rules that aren't in the compiled set.
function collectDescriptions(rs: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, rule] of Object.entries<any>(rs?.rules ?? {})) {
    if (rule && typeof rule === 'object' && typeof rule.description === 'string') out[name] = rule.description;
  }
  return out;
}
export const builtinDescriptions: Record<string, string> = {
  ...collectDescriptions(oas),
  ...collectDescriptions(asyncapi),
  ...collectDescriptions(arazzo),
};

// Rule names contributed by each built-in (extended) ruleset, keyed by format.
export const builtinRulesByFormat: Record<string, string[]> = {
  openapi: Object.keys((oas as any)?.rules ?? {}),
  asyncapi: Object.keys((asyncapi as any)?.rules ?? {}),
  arazzo: Object.keys((arazzo as any)?.rules ?? {}),
};

// Normalize ruleset format strings to the format-function export names.
const FORMAT_ALIASES: Record<string, string> = {
  'oas3.0': 'oas3_0', 'oas3.1': 'oas3_1', oas31: 'oas3_1', oas30: 'oas3_0',
  asyncapi2: 'asyncapi2', 'asyncapi2.0': 'aas2_0', asyncapi3: 'asyncApi2',
  'json-schema': 'jsonSchema', jsonschema: 'jsonSchema',
};
function lookupFormat(name: string): unknown {
  const key = FORMAT_ALIASES[name] ?? name;
  return (fmts as any)[key] ?? (fmts as any)[name];
}

// Convert a data-form ruleset (string functions/formats) to the JS form that
// `new Ruleset()` expects (function/format objects). `extends` is handled
// separately by resolveExtends and is left untouched here.
function toJsForm(node: any): any {
  if (Array.isArray(node)) return node.map(toJsForm);
  if (node && typeof node === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'function' && typeof v === 'string') out[k] = (FN_MAP as any)[v] ?? v;
      else if (k === 'formats' && Array.isArray(v)) out[k] = v.map((f) => (typeof f === 'string' ? lookupFormat(f) : f)).filter(Boolean);
      else out[k] = toJsForm(v);
    }
    return out;
  }
  return node;
}

// Replace string extends (e.g. "spotlight:oas") with the imported ruleset object.
function resolveExtendsList(ext: any): any[] | undefined {
  if (ext == null) return undefined;
  const list = Array.isArray(ext) ? ext : [ext];
  return list.map((entry: any) => {
    if (typeof entry === 'string') return BUILTIN_RULESETS[entry] ?? entry;
    if (Array.isArray(entry) && typeof entry[0] === 'string') {
      return [BUILTIN_RULESETS[entry[0]] ?? entry[0], entry[1]];
    }
    return entry;
  });
}

// Build a JS-form Ruleset from a (possibly data-form) definition.
function buildRuleset(def: any): Ruleset {
  const { extends: ext, ...rest } = def ?? {};
  const jsRest = toJsForm(rest);
  const resolved = resolveExtendsList(ext);
  const full = resolved ? { ...jsRest, extends: resolved } : jsRest;
  return new Ruleset(full, { source: 'inline-ruleset' });
}

// Keep only rules whose tags intersect the active tag set. An empty active set
// means "all rules". Rules with no tags are always kept (e.g. built-in toggles).
export function filterRulesByTags(def: any, activeTags: Set<string>): any {
  if (activeTags.size === 0 || def?.rules == null) return def;
  const rules: Record<string, any> = {};
  for (const [name, rule] of Object.entries<any>(def.rules)) {
    const tags: string[] = (rule && typeof rule === 'object' && Array.isArray(rule.tags)) ? rule.tags : [];
    if (tags.length === 0 || tags.some((t) => activeTags.has(t))) rules[name] = rule;
  }
  return { ...def, rules };
}

export interface LintResult {
  diagnostics: IRuleResult[];
  error?: string;
}

let engine: Spotlight | null = null;
function getEngine(): Spotlight {
  return (engine ??= new Spotlight());
}

export async function lint(documentText: string, rulesetDef: RulesetDefinition, source = 'document', parser: unknown = Parsers.Yaml): Promise<LintResult> {
  try {
    const sp = getEngine();
    sp.setRuleset(buildRuleset(rulesetDef));
    const doc = new Document(documentText, parser as typeof Parsers.Yaml, source);
    const diagnostics = await sp.run(doc);
    return { diagnostics };
  } catch (e) {
    return { diagnostics: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// Collect the distinct tags present in a ruleset's rules, grouped by namespace.
export function collectTags(def: any): { source: string[]; category: string[]; format: string[] } {
  const groups = { source: new Set<string>(), category: new Set<string>(), format: new Set<string>() };
  for (const rule of Object.values<any>(def?.rules ?? {})) {
    const tags: string[] = (rule && typeof rule === 'object' && Array.isArray(rule.tags)) ? rule.tags : [];
    for (const t of tags) {
      const [ns] = t.split(':');
      if (ns in groups) (groups as any)[ns].add(t);
    }
  }
  return {
    source: [...groups.source].sort(),
    category: [...groups.category].sort(),
    format: [...groups.format].sort(),
  };
}
