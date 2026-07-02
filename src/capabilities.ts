// Capability-layer helpers. A capability is the named unit of business function
// above the raw artifacts — this suggests a name for a cluster of member APIs.
// (Discovery composes capability maps; judging which implementation is best is
// API Reusability's job — here the canonical is user-chosen, defaulting to the
// first member.)

const STOP = new Set(['api', 'apis', 'the', 'and', 'for', 'of', 'v1', 'v2', 'v3', 'service', 'services', 'rest', 'com', 'io', 'core', 'public', 'internal', 'app']);

// Suggest a capability name from the shared significant word across member names.
export function suggestName(names: string[]): string {
  const freq: Record<string, number> = {};
  for (const n of names) {
    for (const t of n.toLowerCase().split(/[^a-z0-9]+/)) {
      if (t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t)) freq[t] = (freq[t] || 0) + 1;
    }
  }
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : 'capability';
}
