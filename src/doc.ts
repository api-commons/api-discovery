// Tiny shared helpers for parsing OpenAPI / apis.json text that may be YAML or JSON.
import { parse } from 'yaml';

export type Lang = 'yaml' | 'json';

export function detectLang(text: string): Lang {
  const t = text.trimStart();
  return t.startsWith('{') || t.startsWith('[') ? 'json' : 'yaml';
}

// Parse YAML or JSON leniently; returns null on failure so callers can degrade.
export function parseDoc(text: string): any {
  try {
    return parse(text);
  } catch {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

export const isObject = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

// Grade a 0..100 score into an A–F letter.
export function letterFor(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export const pct = (n: number, d: number): number => (d <= 0 ? 0 : Math.round((n / d) * 100));
