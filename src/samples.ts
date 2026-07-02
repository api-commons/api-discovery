// Built-in sample inventory — 25 synthetic OpenAPI specs that exercise every part
// of the app: three quality tiers (so grades spread A–F), org/team/domain tags
// (so the group scorecards fill in), and DELIBERATE cross-API duplication —
// several teams independently implement /users, /orders, /payments, /products,
// /events, /documents — so the duplication + consolidation views light up.
//
// Specs are generated from compact descriptors so 25 realistic docs stay tidy.
import { stringify } from 'yaml';
import type { ApiProperty } from './storage';

// The demo grouping drives the catalog demo: loading the synthetic set creates
// per-org (and per-domain) catalogs from the same pool — many views, one estate.
export interface Grouping { org?: string; team?: string; domain?: string }
export interface Sample { name: string; grouping: Grouping; openapi: string; properties: ApiProperty[] }

type Quality = 'high' | 'mid' | 'low';

// Resource property shapes → JSON Schema. Reused across specs to create
// near-identical schemas that the duplication scan should catch.
const RES: Record<string, Record<string, string>> = {
  user: { id: 'string', email: 'string', name: 'string', active: 'boolean', createdAt: 'string' },
  order: { id: 'string', userId: 'string', total: 'number', currency: 'string', status: 'string' },
  payment: { id: 'string', orderId: 'string', amount: 'number', currency: 'string', status: 'string' },
  product: { id: 'string', sku: 'string', name: 'string', price: 'number', inStock: 'boolean' },
  shipment: { id: 'string', orderId: 'string', carrier: 'string', tracking: 'string', status: 'string' },
  invoice: { id: 'string', accountId: 'string', amount: 'number', dueDate: 'string', status: 'string' },
  account: { id: 'string', name: 'string', plan: 'string', ownerId: 'string', createdAt: 'string' },
  event: { id: 'string', type: 'string', source: 'string', payload: 'string', createdAt: 'string' },
  document: { id: 'string', title: 'string', body: 'string', author: 'string', updatedAt: 'string' },
  ticket: { id: 'string', subject: 'string', priority: 'string', status: 'string', assignee: 'string' },
  subscription: { id: 'string', accountId: 'string', plan: 'string', renewsAt: 'string', status: 'string' },
  message: { id: 'string', to: 'string', channel: 'string', body: 'string', sentAt: 'string' },
};
const FALLBACK = { id: 'string', name: 'string', status: 'string', createdAt: 'string' };
const ERROR = { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } };

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const propSchema = (map: Record<string, string>) => ({
  type: 'object',
  properties: Object.fromEntries(Object.entries(map).map(([k, t]) => [k, t === 'array' ? { type: 'array', items: { type: 'string' } } : { type: t }])),
});

interface Desc { title: string; org: string; team: string; domain: string; resources: [string, string][]; quality: Quality; meta?: boolean }

function buildOpenApi(d: Desc): string {
  const high = d.quality === 'high';
  const mid = d.quality === 'mid';
  const withServers = high || mid;
  const paths: Record<string, any> = {};
  const schemas: Record<string, any> = {};

  for (const [res, base] of d.resources) {
    const map = RES[res] || FALLBACK;
    const Pascal = cap(res);
    const schema = propSchema(map);
    if (high) { schemas[Pascal] = schema; schemas.Error = ERROR; }

    const ref = { $ref: `#/components/schemas/${Pascal}` };
    const listParams = withServers
      ? [
          { name: 'limit', in: 'query', ...(high ? { description: 'Max items to return' } : {}), schema: { type: 'integer' } },
          { name: 'offset', in: 'query', ...(high ? { description: 'Items to skip' } : {}), schema: { type: 'integer' } },
        ]
      : undefined;
    const idParam = { name: 'id', in: 'path', required: true, ...(high ? { description: `The ${res} id` } : {}), schema: { type: 'string' } };

    const listResp = high
      ? { '200': { description: `A page of ${base}`, content: { 'application/json': { schema: { type: 'array', items: ref } } } }, '400': { description: 'Bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } }
      : mid
        ? { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: schema } } } } }
        : { '200': { description: 'OK' } };
    const oneResp = high
      ? { '200': { description: `A ${res}`, content: { 'application/json': { schema: ref } } }, '404': { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } }
      : mid
        ? { '200': { description: 'OK', content: { 'application/json': { schema } } } }
        : { '200': { description: 'OK' } };
    const body = (schemaBody: any) => ({ required: true, content: { 'application/json': { schema: schemaBody } } });
    const meta = (verb: string, name: string) => ({
      ...(withServers ? { summary: `${verb} ${base}` } : {}),
      ...(high ? { operationId: name, tags: [base] } : mid ? { operationId: name } : {}),
    });

    paths[`/${base}`] = {
      get: { ...meta('List', `list_${base}`), ...(listParams ? { parameters: listParams } : {}), responses: listResp },
      post: {
        ...meta('Create', `create_${base}`),
        ...(high ? { requestBody: body(ref) } : mid ? { requestBody: body(schema) } : {}),
        responses: high ? { '201': { description: 'Created', content: { 'application/json': { schema: ref } } } } : mid ? { '201': { description: 'Created', content: { 'application/json': { schema } } } } : { '200': { description: 'OK' } },
      },
    };
    paths[`/${base}/{id}`] = {
      parameters: [idParam],
      get: { ...meta('Get', `get_${res}`), responses: oneResp },
      put: {
        ...meta('Update', `update_${res}`),
        ...(high ? { requestBody: body(ref) } : mid ? { requestBody: body(schema) } : {}),
        responses: oneResp,
      },
      delete: { ...meta('Delete', `delete_${res}`), responses: { '204': { description: 'Deleted' } } },
    };
  }

  const doc: any = {
    openapi: '3.0.3',
    info: {
      title: d.title,
      version: '1.0.0',
      ...(withServers ? { description: `${d.title} — ${d.domain} domain API owned by the ${d.team} team.` } : {}),
    },
    ...(withServers ? { servers: [{ url: `https://api.${slug(d.org)}.example.com/${slug(d.team)}` }] } : {}),
    paths,
  };
  if (high) {
    doc.components = { schemas, securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } };
    doc.security = [{ bearerAuth: [] }];
  }
  return stringify(doc);
}

// Operational-property richness tiers so Axis B also spreads across the
// inventory: 'full' for well-run APIs (self-service onboarding), 'partial' for
// so-so ones, none for the rest.
function buildProps(d: Desc, tier: 'full' | 'partial'): ApiProperty[] {
  const s = slug(d.title);
  const org = slug(d.org);
  const dev = `https://developer.${org}.example.com/${s}`;
  const make = (type: string, path: string): ApiProperty => ({ type, url: `${dev}/${path}` });
  // full → strong operational (B) + composability (C), like a well-run provider
  const full: ApiProperty[] = [
    make('Documentation', 'docs'), make('GettingStarted', 'start'), make('SignUp', 'signup'),
    make('Login', 'login'), make('Sandbox', 'sandbox'), make('RateLimits', 'limits'),
    make('Webhooks', 'webhooks'), make('StatusPage', 'status'), make('ChangeLog', 'changelog'),
    make('ErrorCodes', 'errors'), make('Support', 'support'), make('SDK', 'sdk'),
    make('Postman', 'postman'), make('Pricing', 'pricing'), { type: 'TermsOfService', url: `https://${org}.example.com/terms` },
    make('Arazzo', 'workflows'), make('MCP', 'mcp'), make('Integrations', 'integrations'),
  ];
  // partial → solid operational metadata + a little composability
  return tier === 'full'
    ? full
    : [
        make('Documentation', 'docs'), make('GettingStarted', 'start'), make('Login', 'login'),
        make('Sandbox', 'sandbox'), make('Support', 'support'), make('RateLimits', 'limits'),
        make('StatusPage', 'status'), make('SDK', 'sdk'), make('Integrations', 'integrations'),
      ];
}

// 25 descriptors. Note the deliberate overlaps: user/users, order/orders,
// payment/payments, product/products, event/events, document/documents each
// appear in multiple specs across different teams and orgs.
const DESCS: Desc[] = [
  { title: 'Identity API', org: 'Acme', team: 'Identity', domain: 'identity', resources: [['user', 'users']], quality: 'high', meta: true },
  { title: 'Accounts API', org: 'Globex', team: 'Accounts', domain: 'identity', resources: [['user', 'users'], ['account', 'accounts']], quality: 'mid' },
  { title: 'Admin Console API', org: 'Acme', team: 'Platform', domain: 'platform', resources: [['user', 'users']], quality: 'low' },
  { title: 'Orders API', org: 'Acme', team: 'Commerce', domain: 'commerce', resources: [['order', 'orders']], quality: 'high', meta: true },
  { title: 'Catalog Orders API', org: 'Globex', team: 'Catalog', domain: 'commerce', resources: [['order', 'orders'], ['product', 'products']], quality: 'mid' },
  { title: 'Payments API', org: 'Acme', team: 'Payments', domain: 'finance', resources: [['payment', 'payments']], quality: 'high', meta: true },
  { title: 'Billing API', org: 'Globex', team: 'Billing', domain: 'finance', resources: [['payment', 'payments'], ['invoice', 'invoices']], quality: 'mid' },
  { title: 'Catalog API', org: 'Acme', team: 'Commerce', domain: 'commerce', resources: [['product', 'products']], quality: 'high', meta: true },
  { title: 'Products API', org: 'Globex', team: 'Catalog', domain: 'commerce', resources: [['product', 'products']], quality: 'low' },
  { title: 'Shipping API', org: 'Acme', team: 'Logistics', domain: 'logistics', resources: [['shipment', 'shipments']], quality: 'high' },
  { title: 'Fulfillment API', org: 'Globex', team: 'Shipping', domain: 'logistics', resources: [['shipment', 'shipments']], quality: 'mid' },
  { title: 'Notifications API', org: 'Acme', team: 'Comms', domain: 'communications', resources: [['message', 'messages']], quality: 'mid' },
  { title: 'Email API', org: 'Acme', team: 'Comms', domain: 'communications', resources: [['message', 'emails']], quality: 'low' },
  { title: 'Audit API', org: 'Acme', team: 'Platform', domain: 'platform', resources: [['event', 'events']], quality: 'mid' },
  { title: 'Feature Flags API', org: 'Acme', team: 'Platform', domain: 'platform', resources: [['flag', 'flags']], quality: 'low' },
  { title: 'Analytics API', org: 'Globex', team: 'Data', domain: 'analytics', resources: [['event', 'events']], quality: 'high' },
  { title: 'Reporting API', org: 'Globex', team: 'Data', domain: 'analytics', resources: [['report', 'reports']], quality: 'mid' },
  { title: 'Auth Tokens API', org: 'Acme', team: 'Identity', domain: 'identity', resources: [['token', 'tokens']], quality: 'mid' },
  { title: 'Sessions API', org: 'Acme', team: 'Identity', domain: 'identity', resources: [['session', 'sessions']], quality: 'low' },
  { title: 'Subscriptions API', org: 'Globex', team: 'Accounts', domain: 'finance', resources: [['subscription', 'subscriptions']], quality: 'high', meta: true },
  { title: 'Refunds API', org: 'Globex', team: 'Billing', domain: 'finance', resources: [['payment', 'refunds']], quality: 'low' },
  { title: 'Tickets API', org: 'Acme', team: 'Support', domain: 'support', resources: [['ticket', 'tickets']], quality: 'high', meta: true },
  { title: 'Knowledge Base API', org: 'Acme', team: 'Support', domain: 'support', resources: [['document', 'documents']], quality: 'mid' },
  { title: 'Documents API', org: 'Globex', team: 'Data', domain: 'analytics', resources: [['document', 'documents']], quality: 'low' },
  { title: 'Inventory API', org: 'Acme', team: 'Logistics', domain: 'logistics', resources: [['product', 'products'], ['shipment', 'shipments']], quality: 'mid' },
];

export const SAMPLES: Sample[] = DESCS.map((d) => ({
  name: d.title,
  grouping: { org: d.org, team: d.team, domain: d.domain },
  openapi: buildOpenApi(d),
  // operational-property richness tracks quality: high → full, mid → partial, low → none
  properties: d.quality === 'high' ? buildProps(d, 'full') : d.quality === 'mid' ? buildProps(d, 'partial') : [],
}));
