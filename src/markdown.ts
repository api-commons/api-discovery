import { getLocationForJsonPath as yamlGetLocation, parseWithPointers, trapAccess } from '@stoplight/yaml';
import type { ILocation, JsonPath, IPosition, IDiagnostic } from '@stoplight/types';

import type { IParser } from '@spotlight-rules/spotlight-parsers';

// A Spectral parser for markdown documents with YAML frontmatter — e.g. agent
// "SKILL.md" files. The frontmatter is parsed as YAML (so rules govern metadata
// via `$.frontmatter.*`), and the markdown body is parsed into a positioned,
// mdast-like tree (`$.body`) plus convenience projections (`$.headings`,
// `$.links`, `$.code`, `$.words`). Lines are 0-based to match Spectral.

type Pos = { start: IPosition; end: IPosition };
export interface MdNode {
  type: string;
  depth?: number;
  text?: string;
  lang?: string;
  url?: string;
  children?: MdNode[];
  position: Pos;
}
export interface MarkdownData {
  frontmatter: Record<string, unknown>;
  body: MdNode;
  headings: Array<{ depth: number; text: string; position: Pos }>;
  links: Array<{ text: string; url: string; position: Pos }>;
  code: Array<{ lang: string; position: Pos }>;
  words: number;
}
export interface MarkdownParserResult {
  data: MarkdownData;
  diagnostics: IDiagnostic[];
  ast: MdNode;
  lineMap: number[];
  // carried for getLocationForJsonPath:
  _fm: ReturnType<typeof parseWithPointers> | null;
  _fmOffset: number;
}

const FM_RE = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/;
const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;
const pos = (sl: number, sc: number, el: number, ec: number): Pos => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });

function extractLinks(text: string, line: number): Array<{ text: string; url: string; position: Pos }> {
  const out: Array<{ text: string; url: string; position: Pos }> = [];
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text)) !== null) out.push({ text: m[1], url: m[2], position: pos(line, m.index, line, m.index + m[0].length) });
  return out;
}

function parseBody(body: string, base: number) {
  const lines = body.split('\n');
  const children: MdNode[] = [];
  const headings: MarkdownData['headings'] = [];
  const links: MarkdownData['links'] = [];
  const code: MarkdownData['code'] = [];
  let words = 0;
  const countWords = (t: string) => { const w = t.trim().split(/\s+/).filter(Boolean).length; words += w; };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const abs = base + i;
    const fence = /^(```|~~~)\s*([\w-]*)/.exec(line);
    if (fence) {
      const lang = fence[2] || '';
      let j = i + 1;
      while (j < lines.length && !new RegExp('^' + fence[1]).test(lines[j])) j++;
      const node: MdNode = { type: 'code', lang, position: pos(abs, 0, base + Math.min(j, lines.length - 1), (lines[j] || '').length) };
      children.push(node); code.push({ lang, position: node.position });
      i = j + 1; continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const depth = h[1].length; const text = h[2];
      const node: MdNode = { type: 'heading', depth, text, position: pos(abs, 0, abs, line.length) };
      children.push(node); headings.push({ depth, text, position: node.position });
      links.push(...extractLinks(text, abs)); countWords(text);
      i++; continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      let j = i;
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) j++;
      children.push({ type: 'table', position: pos(abs, 0, base + j - 1, (lines[j - 1] || '').length) });
      i = j; continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      let j = i; const items: MdNode[] = [];
      while (j < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[j]) || (/^\s+\S/.test(lines[j]) && items.length))) {
        const lm = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[j]);
        if (lm) { items.push({ type: 'listItem', text: lm[2], position: pos(base + j, 0, base + j, lines[j].length) }); links.push(...extractLinks(lm[2], base + j)); countWords(lm[2]); }
        j++;
      }
      children.push({ type: 'list', children: items, position: pos(abs, 0, base + j - 1, (lines[j - 1] || '').length) });
      i = j; continue;
    }
    if (line.trim() === '') { i++; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { children.push({ type: 'thematicBreak', position: pos(abs, 0, abs, line.length) }); i++; continue; }
    // paragraph: until blank / block start
    let j = i; const buf: string[] = [];
    while (j < lines.length && lines[j].trim() !== '' && !/^(#{1,6}\s|```|~~~|\s*([-*+]|\d+[.)])\s)/.test(lines[j])) { buf.push(lines[j]); j++; }
    const text = buf.join(' ');
    const node: MdNode = { type: 'paragraph', text, position: pos(abs, 0, base + j - 1, (lines[j - 1] || '').length) };
    children.push(node); links.push(...extractLinks(text, abs)); countWords(text);
    i = j;
  }
  const root: MdNode = { type: 'root', children, position: pos(base, 0, base + Math.max(lines.length - 1, 0), (lines[lines.length - 1] || '').length) };
  return { root, headings, links, code, words };
}

export const parseMarkdown = (input: string): MarkdownParserResult => {
  let frontmatter: Record<string, unknown> = {};
  let fm: MarkdownParserResult['_fm'] = null;
  let fmOffset = 0;
  let body = input;
  const m = FM_RE.exec(input);
  if (m) {
    fm = parseWithPointers(m[1], { ignoreDuplicateKeys: false, mergeKeys: true, preserveKeyOrder: true, attachComments: false });
    if (fm.data && typeof fm.data === 'object') frontmatter = fm.data as Record<string, unknown>;
    fmOffset = (input.slice(0, m.index).match(/\n/g)?.length ?? 0) + 1; // content starts on the line after the opening '---'
    body = input.slice(m[0].length);
  }
  const bodyBase = m ? m[0].replace(/\r?\n$/, '').split('\n').length : 0;
  const { root, headings, links, code, words } = parseBody(body, bodyBase);
  const diagnostics = ((fm?.diagnostics ?? []) as IDiagnostic[]).map((d) => ({
    ...d,
    range: { start: { line: d.range.start.line + fmOffset, character: d.range.start.character }, end: { line: d.range.end.line + fmOffset, character: d.range.end.character } },
  })) as IDiagnostic[];
  return { data: { frontmatter, body: root, headings, links, code, words }, diagnostics, ast: root, lineMap: [], _fm: fm, _fmOffset: fmOffset };
};

function getLocationForJsonPath(result: MarkdownParserResult, path: JsonPath): ILocation | undefined {
  if (path[0] === 'frontmatter') {
    if (!result._fm) return undefined;
    const loc = yamlGetLocation(result._fm as never, path.slice(1));
    if (!loc) return undefined;
    return { range: { start: { line: loc.range.start.line + result._fmOffset, character: loc.range.start.character }, end: { line: loc.range.end.line + result._fmOffset, character: loc.range.end.character } } };
  }
  // Walk the data tree, remembering the deepest node that carries a position.
  let node: unknown = result.data;
  let last: Pos | undefined;
  for (const seg of path) {
    if (node == null || typeof node !== 'object') break;
    node = (node as Record<string, unknown>)[seg as string];
    if (node && typeof node === 'object' && 'position' in (node as Record<string, unknown>)) last = (node as { position: Pos }).position;
  }
  return last ? { range: last } : undefined;
}

export const Markdown: IParser<MarkdownParserResult> = {
  parse: parseMarkdown,
  getLocationForJsonPath: getLocationForJsonPath as IParser<MarkdownParserResult>['getLocationForJsonPath'],
  trapAccess,
};
