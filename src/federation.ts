// Federation — the catalog-of-catalogs. Instead of one static central catalog,
// an org publishes many small purpose/domain/team catalogs and links them with a
// lightweight APIs.json `includes` index. This file generates that index.
import { stringify } from 'yaml';
import type { Catalog } from './storage';

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'catalog';
export const catalogFileName = (c: Catalog) => `${slug(c.name)}.apis.yaml`;

export function buildCatalogOfCatalogs(catalogs: Catalog[], baseUrl?: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const base = (baseUrl || '').replace(/\/$/, '');
  const doc: any = {
    specificationVersion: '0.21',
    name: 'Catalog of Catalogs',
    description: `A federated index of ${catalogs.length} purpose-built API catalog${catalogs.length === 1 ? '' : 's'} — domain, team, and category views composed on demand, not a static central catalog.`,
    created: today,
    modified: today,
    includes: catalogs.map((c) => ({
      name: c.name,
      url: base ? `${base}/${catalogFileName(c)}` : catalogFileName(c),
    })),
  };
  return stringify(doc);
}
