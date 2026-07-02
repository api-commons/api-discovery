// The API-property catalog — the single, shared definition of the operational and
// composability metadata that makes an API reusable. Both the properties editor
// (dropdown) and the Axis B / Axis C scorers read from this list, so the published
// rubric and the UI can never drift apart.
//
// v2: weights and the split into Axis B (operational) vs Axis C (composability /
// agent-readiness) are grounded in what 900+ real provider APIs actually publish.
// The principle is discriminating-power × reuse-relevance: rare-but-valuable signals
// (Sandbox, Rate Limits, Arazzo, MCP) outweigh ubiquitous hygiene (Documentation).
import { parseDoc, isObject } from './doc';
import type { ApiProperty } from './storage';

export type Axis = 'B' | 'C';

export interface PropDef {
  type: string; // canonical apis.json property type
  label: string; // UI label
  help: string; // what it is / why it matters
  weight: number; // contribution to its axis
  axis: Axis; // B = operational reusability, C = composability / agent-readiness
}

// Axis B — operational reusability: can a developer find, onboard to, operate,
// and consume the API? Axis C — composability: can it be reused as a capability,
// by an agent, or wired into workflows?
export const COMMON_PROPERTIES: PropDef[] = [
  // Axis B — onboarding
  { type: 'Documentation', label: 'Documentation', help: 'Reference / guides a developer can read', weight: 1, axis: 'B' },
  { type: 'GettingStarted', label: 'Getting Started', help: 'A quickstart that gets you to a first call', weight: 1.5, axis: 'B' },
  { type: 'SignUp', label: 'Sign Up', help: 'Self-service registration to get access', weight: 1.5, axis: 'B' },
  { type: 'Login', label: 'Login', help: 'Authentication / sign-in entry point', weight: 1, axis: 'B' },
  { type: 'Sandbox', label: 'Sandbox', help: 'A place to try the API before integrating', weight: 2, axis: 'B' },
  // Axis B — operability
  { type: 'RateLimits', label: 'Rate Limits', help: 'Published limits so consumers can budget usage', weight: 2, axis: 'B' },
  { type: 'StatusPage', label: 'Status', help: 'Uptime / incident status', weight: 1, axis: 'B' },
  { type: 'ChangeLog', label: 'Changelog', help: 'Version history / release notes', weight: 1, axis: 'B' },
  { type: 'ErrorCodes', label: 'Error Codes', help: 'A catalog of error codes and their meaning', weight: 1, axis: 'B' },
  { type: 'Webhooks', label: 'Webhooks', help: 'Event / callback delivery for async reuse', weight: 1, axis: 'B' },
  { type: 'Support', label: 'Support', help: 'How to get help (portal, email, contact)', weight: 1, axis: 'B' },
  // Axis B — consumption tooling
  { type: 'SDK', label: 'SDK', help: 'Client libraries', weight: 1, axis: 'B' },
  { type: 'CLI', label: 'CLI', help: 'Command-line client', weight: 0.5, axis: 'B' },
  { type: 'Postman', label: 'Postman / Collection', help: 'A ready-to-run request collection', weight: 1, axis: 'B' },
  // Axis B — commercial
  { type: 'Pricing', label: 'Pricing / Plans', help: 'Cost and access tiers', weight: 0.5, axis: 'B' },
  { type: 'TermsOfService', label: 'Terms of Service', help: 'Rules of use', weight: 0.5, axis: 'B' },
  // Axis C — composability / agent-readiness
  { type: 'Arazzo', label: 'Arazzo Workflows', help: 'Machine-readable multi-step workflows — the unit of reuse', weight: 2, axis: 'C' },
  { type: 'MCP', label: 'MCP Server', help: 'Model Context Protocol server — agent-ready reuse', weight: 2, axis: 'C' },
  { type: 'AgentSkills', label: 'Agent Skills', help: 'Packaged skills for agent orchestration', weight: 1.5, axis: 'C' },
  { type: 'Integrations', label: 'Integrations', help: 'Prebuilt integrations / connectors', weight: 1, axis: 'C' },
  { type: 'UseCases', label: 'Use Cases', help: 'Documented ways the API is reused', weight: 1, axis: 'C' },
];

export const propDef = (type: string) => COMMON_PROPERTIES.find((p) => p.type === type);
export const propsByAxis = (axis: Axis) => COMMON_PROPERTIES.filter((p) => p.axis === axis);

// Synonyms so imported / preset apis.json properties match a catalog entry
// regardless of exact spelling / x- prefixes.
const SYNONYMS: Record<string, string[]> = {
  Documentation: ['documentation', 'docs', 'apidocs', 'reference', 'apireference'],
  GettingStarted: ['gettingstarted', 'quickstart', 'getstarted', 'onboarding'],
  SignUp: ['signup', 'register', 'registration'],
  Login: ['login', 'signin', 'authentication', 'auth', 'oauth', 'apikeys'],
  Sandbox: ['sandbox', 'testconsole', 'tryit', 'playground', 'testenvironment', 'demo'],
  RateLimits: ['ratelimits', 'ratelimit', 'ratelimiting', 'throttling', 'quotas'],
  StatusPage: ['statuspage', 'status', 'uptime'],
  ChangeLog: ['changelog', 'releasenotes', 'releases', 'versioning'],
  ErrorCodes: ['errorcodes', 'errors', 'errorreference'],
  Webhooks: ['webhooks', 'webhook', 'events', 'eventsubscriptions', 'callbacks'],
  Support: ['support', 'contact', 'help', 'helpdesk', 'discord', 'stackoverflow', 'community'],
  SDK: ['sdk', 'sdks', 'clientlibraries', 'libraries', 'library'],
  CLI: ['cli', 'commandline'],
  Postman: ['postman', 'postmanworkspace', 'collection', 'collections', 'bruno'],
  Pricing: ['pricing', 'plans', 'plan', 'billing'],
  TermsOfService: ['termsofservice', 'terms', 'tos'],
  Arazzo: ['arazzo', 'workflows', 'workflow'],
  MCP: ['mcp', 'mcpserver', 'modelcontextprotocol'],
  AgentSkills: ['agentskills', 'agentskill', 'skills'],
  Integrations: ['integrations', 'integration', 'connectors'],
  UseCases: ['usecases', 'usecase', 'recipes', 'tutorials'],
};
const norm = (s: string) => String(s || '').toLowerCase().replace(/^x-/, '').replace(/[^a-z0-9]+/g, '');

// Does a property list contain a property matching this catalog def?
export function hasType(props: ApiProperty[], def: PropDef): boolean {
  const wanted = new Set([norm(def.type), ...(SYNONYMS[def.type] || [])]);
  return props.some((p) => wanted.has(norm(p.type)));
}

// Parse a legacy apis.json fragment (full doc or single entry) into properties.
export function parseApisJsonProps(text?: string): ApiProperty[] {
  if (!text) return [];
  const doc = parseDoc(text);
  if (!isObject(doc)) return [];
  const entry = Array.isArray(doc.apis) ? doc.apis[0] : doc;
  const props = [
    ...(Array.isArray(entry?.properties) ? entry.properties : []),
    ...(Array.isArray(doc.common) ? doc.common : []),
  ];
  return props
    .filter((p: any) => isObject(p) && p.type)
    .map((p: any) => ({ type: String(p.type), name: p.name ? String(p.name) : undefined, url: String(p.url || '') }));
}

// The properties for a record: structured `properties` if present, otherwise
// derived from any legacy apis.json text.
export function resolveProperties(rec: { properties?: ApiProperty[]; apisjson?: string }): ApiProperty[] {
  if (Array.isArray(rec.properties)) return rec.properties;
  return parseApisJsonProps(rec.apisjson);
}
