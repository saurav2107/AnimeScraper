import type { SizeKind } from "./categories";

// Category-aware size extraction (FR-SCR-05). Never invents values.

// "in" must not be the start of a word ("3 interchangeable") nor part of "5 in 1".
const UNIT_BASE = String.raw`cm|centimet(?:er|re)s?|mm|millimet(?:er|re)s?|inch(?:es)?|in(?![a-z])(?!\s*\d)|"`;
const UNIT = String.raw`(${UNIT_BASE}|m(?![a-z])|met(?:er|re)s?)`; // anchored matches may use metres
const UNIT_NO_M = String.raw`(${UNIT_BASE})`;
const NUM = String.raw`(\d{1,3}(?:[.,]\d{1,2})?)`;

function toCm(n: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u.startsWith("mm") || u.startsWith("milli")) return n / 10;
  if (u === "m" || u.startsWith("met")) return n * 100;
  if (u === "in" || u.startsWith("inch") || u === '"') return n * 2.54;
  return n;
}
const round1 = (n: number) => String(Math.round(n * 10) / 10);
const num = (s: string) => parseFloat(s.replace(",", "."));

function anchored(text: string, anchors: string[]): number[] {
  const out: number[] = [];
  const a = anchors.join("|");
  // "Height: 30cm", "30cm tall", "height 30 cm"
  const before = new RegExp(String.raw`(?:${a})\s*(?:of|is|:|-|=)?\s*(?:approx(?:imately)?\.?|about|around|~)?\s*${NUM}\s*${UNIT}`, "gi");
  const after = new RegExp(String.raw`${NUM}\s*${UNIT}\s*(?:approx(?:imately)?\.?)?\s*(?:${a})`, "gi");
  for (const re of [before, after]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) out.push(toCm(num(m[1]), m[2]));
  }
  return out;
}

function anyMeasurements(text: string): number[] {
  const re = new RegExp(String.raw`${NUM}\s*${UNIT_NO_M}`, "gi");
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(toCm(num(m[1]), m[2]));
  return out;
}

function distinct(vals: number[]): number[] {
  return [...new Set(vals.map((v) => Math.round(v * 10) / 10))];
}

export function extractHeight(text: string): string | null {
  const vals = distinct(anchored(text, ["height", "tall", "high"]).filter((v) => v >= 1 && v <= 200));
  return vals.length === 1 ? round1(vals[0]) : null;
}

export function extractLength(text: string): string | null {
  const anchoredVals = distinct(anchored(text, ["length", "long", "overall", "total"]).filter((v) => v >= 5 && v <= 250));
  if (anchoredVals.length === 1) return round1(anchoredVals[0]);
  if (anchoredVals.length > 1) return null;
  const all = distinct(anyMeasurements(text).filter((v) => v >= 5 && v <= 250));
  return all.length === 1 ? round1(all[0]) : null;
}

export function extractScale(text: string): string | null {
  const re = /\b1\s*[:/]\s*(\d{1,3})\b/g;
  const vals = new Set<number>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const d = parseInt(m[1], 10);
    if (d >= 2 && d <= 500) vals.add(d);
  }
  return vals.size === 1 ? `1:${[...vals][0]}` : null;
}

/** A single bare measurement in a product name ("Goku Figure 30cm") is taken as its height. */
function bareHeight(name: string): string | null {
  const vals = distinct(anyMeasurements(name).filter((v) => v >= 1 && v <= 200));
  return vals.length === 1 ? round1(vals[0]) : null;
}

/** Sources are searched in order: name, description, attributes (first hit wins).
 *  Height also falls back to a lone unlabelled measurement in the name (sources[0]). */
export function extractSize(kind: SizeKind, sources: string[]): string | null {
  if (kind === "other") return null;
  const fn = kind === "height" ? extractHeight : kind === "length" ? extractLength : extractScale;
  for (const s of sources) {
    if (!s) continue;
    const v = fn(s);
    if (v) return v;
  }
  if (kind === "height" && sources[0]) return bareHeight(sources[0]);
  return null;
}

/** Numeric sort key: cm value, or scale denominator (PRD §7.2). */
export function sizeSortKey(v: string | null): number | null {
  if (!v) return null;
  if (v.startsWith("1:")) return parseInt(v.slice(2), 10);
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
