// Custom Spotlight functions for agent-skill rules (mirror spotlight:skill in the cli).
// Used by rules/defaults/agent-skill.yaml via the function name → ref map (FN_MAP).
type Heading = { text?: string; depth?: number };
type SkillData = { headings?: Heading[] };

export function headingPresent(input: SkillData | undefined, opts: { name: string; maxDepth?: number }) {
  const want = String(opts.name).toLowerCase();
  const max = opts.maxDepth ?? 3;
  const found = (input?.headings ?? []).some((h) => (h.depth ?? 6) <= max && String(h.text ?? '').toLowerCase() === want);
  if (!found) return [{ message: `Skill body should have a "${opts.name}" section (e.g. "## ${opts.name}").` }];
  return undefined;
}

export function headingCount(input: SkillData | undefined, opts: { depth?: number; max?: number }) {
  const depth = opts.depth ?? 1;
  const max = opts.max ?? 1;
  const n = (input?.headings ?? []).filter((h) => (h.depth ?? 6) === depth).length;
  if (n > max) return [{ message: `Skill body should have at most ${max} level-${depth} heading(s) (found ${n}); use "##" for sections.` }];
  return undefined;
}
