// Artifact types — the discovery vocabulary. Each maps to an
// APIs.io endpoint (and a GitHub search qualifier lives in sources.ts by id).
export interface ArtifactType { id: string; label: string; endpoint: string; format: string; searchNote?: string }
export const ARTIFACTS: ArtifactType[] = [
  { id: 'apis-json', label: 'APIs.json', endpoint: 'apis-json', format: 'apis-json' },
  { id: 'openapi', label: 'OpenAPI', endpoint: 'openapis', format: 'openapi' },
  { id: 'mcp', label: 'MCP', endpoint: 'mcp', format: 'mcp', searchNote: 'MCP artifacts will appear here as the APIs.io catalog indexes them.' },
  { id: 'arazzo', label: 'Arazzo', endpoint: 'arazzo', format: 'arazzo' },
  { id: 'asyncapi', label: 'AsyncAPI', endpoint: 'asyncapis', format: 'asyncapi' },
  { id: 'json-schema', label: 'JSON Schema', endpoint: 'json-schemas', format: 'jsonschema' },
  { id: 'json-structure', label: 'JSON Structure', endpoint: 'json-structures', format: 'json-structure' },
  { id: 'json-ld', label: 'JSON-LD', endpoint: 'json-ld', format: 'json-ld' },
  { id: 'plans', label: 'Plans', endpoint: 'plans', format: 'plans' },
  { id: 'rate-limits', label: 'Rate Limits', endpoint: 'rate-limits', format: 'rate-limits' },
  { id: 'finops', label: 'FinOps', endpoint: 'finops', format: 'finops' },
  { id: 'agent-skill', label: 'Agent Skill', endpoint: 'skills', format: 'agent-skill', searchNote: 'Agent skills (SKILL.md) — search GitHub, or APIs.io as it indexes them.' },
];
export const artifactById = (id: string) => ARTIFACTS.find((a) => a.id === id) || ARTIFACTS[1];
