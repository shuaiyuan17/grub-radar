import { LIMITS } from '../domain/spot';

/** "noodles, Spicy，cheap" -> ["noodles", "spicy", "cheap"] (ASCII and CJK commas). */
export function parseTags(raw: string): string[] {
  const tags = raw
    .split(/[,，、]/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(tags)].slice(0, LIMITS.tags);
}
