// Joins the first batch of news templates (newsText.ts, memeNews.ts) with the extra ones added later (newsMore*.ts, memeNewsMore.ts), so every
// kind of story has plenty of different wordings. The extra templates go at the END of each list: the draws that decide a story's direction,
// strength, timing and size are made before the wording is picked and never depend on the text, so more templates change only which words a
// NEW story gets; no price, no story that is already saved and no number in a report changes (tests/world-news.test.ts).
import type { TemplateSet } from './newsText';

const DIRECTIONS = ['positive', 'negative', 'uncertain'] as const;

/** A set followed by more templates of the same directions. */
export function plus(base: TemplateSet, more: TemplateSet | undefined): TemplateSet {
  if (!more) return base;
  const out: { -readonly [K in keyof TemplateSet]: TemplateSet[K] } = {};
  for (const d of DIRECTIONS) {
    const joined = [...(base[d] ?? []), ...(more[d] ?? [])];
    if (joined.length > 0) out[d] = joined;
  }
  return out;
}

/** The same for a record of sets (a set for each category, sector or kind of viral story). */
export function plusEach<K extends string>(base: Readonly<Record<K, TemplateSet>>, more: Readonly<Partial<Record<K, TemplateSet>>>): Readonly<Record<K, TemplateSet>> {
  const out = {} as Record<K, TemplateSet>;
  for (const key of Object.keys(base) as K[]) out[key] = plus(base[key], more[key]);
  return out;
}
