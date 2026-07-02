// Example provider sets — fetched CROSS-ORIGIN from the API Reusability project,
// which generates and hosts them (53 sets, ~1,300 real APIs, regenerated from the
// api-evangelist all/* repos). Discovery deliberately does not duplicate the
// payload; if the presets move, update BASES below.
import { SAMPLES, type Sample } from './samples';

const BASES = [
  'https://reusability.apicommons.org/presets',
  // raw fallback (also serves CORS *)
  'https://raw.githubusercontent.com/api-commons/api-reusability/main/public/presets',
];

export interface PresetSet {
  id: string;
  label: string;
  kind: 'builtin' | 'remote';
}

const remote = (id: string, label: string): PresetSet => ({ id, label, kind: 'remote' });

// The synthetic demo (pinned first) + real providers, alphabetized by label.
const DEMO: PresetSet = { id: 'sample', label: 'Demo org — 25 synthetic APIs', kind: 'builtin' };
const PROVIDERS: PresetSet[] = [
  remote('adyen', 'Adyen — payments'),
  remote('amadeus', 'Amadeus — travel'),
  remote('asana', 'Asana — productivity'),
  remote('atlassian', 'Atlassian — developer tools'),
  remote('auth0', 'Auth0 — identity'),
  remote('avalara', 'Avalara — tax'),
  remote('bigcommerce', 'BigCommerce — commerce'),
  remote('binance', 'Binance — crypto'),
  remote('box', 'Box — storage'),
  remote('bunq', 'bunq — banking'),
  remote('chainstack', 'Chainstack — infrastructure'),
  remote('chatgpt', 'ChatGPT — AI'),
  remote('webex', 'Cisco Webex — communications'),
  remote('claude', 'Claude — AI'),
  remote('cloudflare', 'Cloudflare — infrastructure'),
  remote('coveo', 'Coveo — search'),
  remote('datadog', 'Datadog — observability'),
  remote('discord', 'Discord — communications'),
  remote('docusign', 'DocuSign — documents'),
  remote('ebay', 'eBay — commerce'),
  remote('factset', 'FactSet — financial data'),
  remote('fastly', 'Fastly — infrastructure'),
  remote('figma', 'Figma — design'),
  remote('fireblocks', 'Fireblocks — crypto'),
  remote('github', 'GitHub — developer tools'),
  remote('gitlab', 'GitLab — developer tools'),
  remote('google', 'Google — cloud'),
  remote('hubspot', 'HubSpot — CRM'),
  remote('klarna', 'Klarna — payments'),
  remote('linkedin', 'LinkedIn — social'),
  remote('mastercard', 'Mastercard — payments'),
  remote('microsoft-graph', 'Microsoft Graph — productivity'),
  remote('openai', 'OpenAI — AI'),
  remote('palo-alto', 'Palo Alto Networks — security'),
  remote('paypal', 'PayPal — payments'),
  remote('plaid', 'Plaid — fintech'),
  remote('salesforce', 'Salesforce — CRM'),
  remote('sendgrid', 'SendGrid — email'),
  remote('sentry', 'Sentry — developer tools'),
  remote('shopify', 'Shopify — commerce'),
  remote('slack', 'Slack — communications'),
  remote('stripe', 'Stripe — payments'),
  remote('twilio', 'Twilio — communications'),
  remote('vapi', 'Vapi — AI'),
  remote('visa', 'Visa — payments'),
  remote('vtex', 'VTEX — commerce'),
  remote('walmart', 'Walmart — commerce'),
  remote('webflow', 'Webflow — commerce'),
  remote('workday', 'Workday — HR'),
  remote('worldpay', 'Worldpay — payments'),
  remote('youtube', 'YouTube — media'),
  remote('zendesk', 'Zendesk — CRM'),
  remote('zoom', 'Zoom — communications'),
].sort((a, b) => a.label.localeCompare(b.label));
export const PRESET_SETS: PresetSet[] = [DEMO, ...PROVIDERS];

export async function loadPresetSet(id: string): Promise<Sample[]> {
  const set = PRESET_SETS.find((s) => s.id === id);
  if (!set) throw new Error(`Unknown set: ${id}`);
  if (set.kind === 'builtin') return SAMPLES;
  let lastErr = '';
  for (const base of BASES) {
    try {
      const res = await fetch(`${base}/${id}.json`);
      if (!res.ok) { lastErr = `${base} → ${res.status}`; continue; }
      const doc = await res.json();
      return (doc.apis || []).map((a: any) => ({
        name: String(a.name || 'API'),
        grouping: a.grouping || {},
        openapi: String(a.openapi || ''),
        properties: Array.isArray(a.properties) ? a.properties : [],
      }));
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`Could not fetch ${id}: ${lastErr}`);
}
