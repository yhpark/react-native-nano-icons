import { XMLParser } from 'fast-xml-parser';
import { parseColor } from '../../utils/parse';

export type ParsedFlatSvg = {
  viewBox: [number, number, number, number];
  paths: Array<{ d: string; fill: string | null; fillRule?: 'evenodd' }>;
};

// Minimal XML node shape. Parent pointer lets us walk ancestors for
// inherited attributes (e.g. fill) without re-traversing the tree.
export type XmlNode = {
  tag: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  parent: XmlNode | null;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  preserveOrder: true,
  allowBooleanAttributes: true,
  parseAttributeValue: false,
  trimValues: false,
});

// fast-xml-parser preserveOrder output shape:
//   [{ <tag>: <childrenArray>, ':@': { <attr>: <value> } }, ...]
// Text/comment/declaration nodes appear under keys starting with '#'
// and are skipped — only element structure matters for SVG extraction.
type RawNode = Record<string, unknown> & { ':@'?: Record<string, string> };

function toTree(raw: RawNode[], parent: XmlNode | null): XmlNode[] {
  const out: XmlNode[] = [];
  for (const entry of raw) {
    const tag = Object.keys(entry).find(
      (k) => k !== ':@' && !k.startsWith('#')
    );
    if (!tag) continue;
    const node: XmlNode = {
      tag,
      attrs: entry[':@'] ?? {},
      children: [],
      parent,
    };
    node.children = toTree((entry[tag] as RawNode[]) ?? [], node);
    out.push(node);
  }
  return out;
}

function parseXml(content: string): XmlNode[] {
  return toTree(parser.parse(content) as RawNode[], null);
}

function getAttr(n: XmlNode, name: string): string | null {
  return Object.prototype.hasOwnProperty.call(n.attrs, name)
    ? n.attrs[name]!
    : null;
}

function findFirst(nodes: XmlNode[], tag: string): XmlNode | null {
  for (const n of nodes) {
    if (n.tag === tag) return n;
    const found = findFirst(n.children, tag);
    if (found) return found;
  }
  return null;
}

function collectByTag(
  nodes: XmlNode[],
  tag: string,
  out: XmlNode[] = []
): XmlNode[] {
  for (const n of nodes) {
    if (n.tag === tag) out.push(n);
    if (n.children.length) collectByTag(n.children, tag, out);
  }
  return out;
}

// if the fill is implicit, walk ancestors for the first explicit fill value
function resolveInheritedFill(node: XmlNode): string {
  let current = node.parent;
  while (current !== null) {
    const fill = getAttr(current, 'fill');
    if (fill !== null && fill !== 'inherit') return fill;
    current = current.parent;
  }
  return 'black';
}

// bake opacity into the fill as an rgba(...)
export function calculateOpColor(
  fill: string | null,
  opacity: number,
  el: XmlNode
): `rgba(${number},${number},${number},${number})` {
  const resolvedFill = fill ?? resolveInheritedFill(el);
  const [r, g, b, a] = parseColor(resolvedFill);
  const finalAlpha = +(a * opacity).toFixed(4);
  return `rgba(${r},${g},${b},${finalAlpha})`;
}

/**
 * If a flattened path lost its initial moveto (e.g. picosvg dropped an empty
 * `Mx y z` subpath), prepend `M` using the path's last coordinate pair.
 * For closed icon shapes the endpoint equals the start point.
 */
export function sanitizePathData(d: string): { d: string; sanitized: boolean } {
  const trimmed = d.trim();
  if (!trimmed || /^[Mm]/.test(trimmed)) {
    return { d: trimmed, sanitized: false };
  }

  // Strip trailing close commands, then grab the last two numbers as x,y
  const withoutClose = trimmed.replace(/[Zz]\s*$/, '');
  const nums = withoutClose.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 2) {
    return { d: trimmed, sanitized: false };
  }

  const x = nums[nums.length - 2];
  const y = nums[nums.length - 1];
  return { d: `M${x},${y} ${trimmed}`, sanitized: true };
}

export const parsePath = (
  p: XmlNode
): { d: string; fill: string | null; fillRule?: 'evenodd' } => {
  const d = getAttr(p, 'd') ?? '';

  const op = getAttr(p, 'opacity');
  const fillOp = getAttr(p, 'fill-opacity');
  const fill = getAttr(p, 'fill');
  // picosvg may drop fill-rule but preserve clip-rule; treat either as evenodd
  const fillRule =
    getAttr(p, 'fill-rule') === 'evenodd' ||
    getAttr(p, 'clip-rule') === 'evenodd'
      ? ('evenodd' as const)
      : undefined;

  if (op !== null || fillOp !== null) {
    const opVal = op !== null ? parseFloat(op) : 1;
    const fillOpVal = fillOp !== null ? parseFloat(fillOp) : 1;
    const combinedOpacity = opVal * fillOpVal;
    return {
      d,
      fill: calculateOpColor(fill, combinedOpacity, p),
      fillRule,
    };
  }

  return {
    d,
    fill,
    fillRule,
  };
};

export function parseFlattenedSvg(
  flattenedSvg: string,
  options?: { onSanitize?: (original: string) => void }
): ParsedFlatSvg {
  const tree = parseXml(flattenedSvg);
  const svgEl = findFirst(tree, 'svg');

  const viewBoxRaw = svgEl
    ? (getAttr(svgEl, 'viewBox')?.split(/\s+/).map(Number) ?? [0, 0, 100, 100])
    : [0, 0, 100, 100];

  const viewBox: [number, number, number, number] =
    viewBoxRaw.length === 4 && viewBoxRaw.every((n) => Number.isFinite(n))
      ? [viewBoxRaw[0]!, viewBoxRaw[1]!, viewBoxRaw[2]!, viewBoxRaw[3]!]
      : [0, 0, 100, 100];

  const pathEls = collectByTag(tree, 'path');

  const paths = pathEls
    .map(parsePath)
    .filter((p) => p.d.trim() !== '')
    .map((p) => {
      const { d, sanitized } = sanitizePathData(p.d);
      if (sanitized) {
        options?.onSanitize?.(p.d);
      }
      return { ...p, d };
    });

  return { viewBox, paths };
}

export function shouldSkipPath(d: string, fill: string | null): boolean {
  if (!d || d.trim() === '') return true;
  const f = (fill ?? '').trim().toLowerCase();
  return f === 'transparent' || f === 'none';
}

export type SvgValidation = { valid: true } | { valid: false; reason: string };

export function validateSvg(content: string): SvgValidation {
  if (/<mask[\s>]/i.test(content)) {
    return { valid: false, reason: '<mask> is not supported yet' };
  }
  if (/<filter[\s>]/i.test(content)) {
    return { valid: false, reason: '<filter> is not supported yet' };
  }
  return { valid: true };
}

/**
 * Extract the original `d` strings of evenodd paths from the raw SVG
 * BEFORE picosvg processes it. Picosvg's simplify (via our PathKit shim)
 * can drop contours from multi-subpath evenodd paths, so we preserve
 * the originals and apply our own winding conversion later.
 *
 * Returns one `d` string per evenodd path, in document order.
 */
export function extractOriginalEvenoddDs(svgContent: string): string[] {
  if (!/<[^>]*fill-rule\s*=\s*["']evenodd/i.test(svgContent)) {
    return [];
  }

  const tree = parseXml(svgContent);
  const pathEls = collectByTag(tree, 'path').filter(
    (p) =>
      getAttr(p, 'fill-rule') === 'evenodd' ||
      getAttr(p, 'clip-rule') === 'evenodd'
  );

  const results: string[] = [];
  for (const el of pathEls) {
    const d = getAttr(el, 'd');
    if (d) results.push(d);
  }
  return results;
}

/**
 * Replace picosvg's (potentially damaged) evenodd path data with the
 * preserved originals. Matches by position: the Nth evenodd path in
 * the parsed output gets the Nth original `d` string.
 */
export function restoreOriginalEvenoddDs(
  paths: ParsedFlatSvg['paths'],
  originalDs: string[]
): void {
  let oi = 0;
  for (const p of paths) {
    if (p.fillRule === 'evenodd' && oi < originalDs.length) {
      p.d = originalDs[oi]!;
      oi++;
    }
  }
}

// ensure the svg has a xmlns attribute
export function preprocessSvg(content: string): string {
  if (/xmlns\s*=/.test(content)) return content;
  return content.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
}
