// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// It applies an edit an AI model wrote to a tree of text files, in four formats:
// unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches
// and text-editor tool calls as JSON. Every file is changed or nothing is.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, in order: used to print `R old -> new` rows. */
  moves: Array<{ old: string; new: string }> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  /**
   * True when the path exists in the tree as the edits leave it. Unlike get(),
   * a directory on disk counts as existing: section 2's `exists` is for a path
   * that exists, and creating a file over a directory must fail cleanly with
   * `exists` instead of crashing in the write phase (EISDIR). A path an
   * earlier edit deleted counts as not existing.
   */
  exists(p: string): boolean {
    if (this.now.has(p)) return this.now.get(p) !== null;
    try {
      statSync(p);
      return true;
    } catch {
      return false;
    }
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.exists(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Files as lines (SPEC.md section 3) and matching at three tiers (section 5).
// ---------------------------------------------------------------------------

interface FileText {
  br: string;
  lines: string[];
  final: boolean;
}

/** Split a file's text at its own line break; `final` says it ends with one. */
function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const trailWS = (s: string): string => s.replace(/[ \t]+$/, '');
const leadWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWS(a) === trailWS(b);
  return trimWS(a) === trimWS(b);
}

/** 0-based positions where O matches lines[from..] at the tier. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

/**
 * O is the context and `-` lines, N the context and `+` lines, each in body
 * order; `ctx[n]` is the index in O of N's line when that line is a context
 * line, else -1.
 */
function hunkON(body: BodyLine[]): { o: string[]; n: string[]; ctx: number[] } {
  const o: string[] = [];
  const n: string[] = [];
  const ctx: number[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      ctx.push(o.length);
      o.push(b.text);
      n.push(b.text);
    } else if (b.kind === 'old') {
      o.push(b.text);
    } else if (b.kind === 'new') {
      ctx.push(-1);
      n.push(b.text);
    }
  }
  return { o, n, ctx };
}

/**
 * The lines that replace the matched region: a context line is written as the
 * file's own matched line, never the patch's; at tier 2 every other line is
 * re-indented from O's first line's leading whitespace to the file's.
 */
function buildReplacement(fileLines: string[], pos: number, o: string[], n: string[], ctx: number[], tier: number): string[] {
  if (tier === 2 && o.length > 0) {
    const f = leadWS(fileLines[pos]!);
    const p = leadWS(o[0]!);
    return n.map((line, ni) => {
      const oi = ctx[ni]!;
      if (oi >= 0) return fileLines[pos + oi]!;
      if (line === '' || /^[ \t]+$/.test(line)) return line;
      if (line.startsWith(p)) return f + line.slice(p.length);
      return line;
    });
  }
  return n.map((line, ni) => {
    const oi = ctx[ni]!;
    return oi >= 0 ? fileLines[pos + oi]! : line;
  });
}

/** Index of the last context or `+` line in a body, or -1 when there is none. */
function lastCtxOrNew(body: BodyLine[]): number {
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i]!.kind === 'ctx' || body[i]!.kind === 'new') return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6).
// ---------------------------------------------------------------------------

interface Hunk {
  /** Old start line number A (1-based) from the `@@ -A ... @@` header. */
  a: number;
  body: BodyLine[];
}

interface Section {
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path after `--- ` / `+++ `: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const t = line.slice(4);
  const tab = t.indexOf('\t');
  return (tab >= 0 ? t.slice(0, tab) : t).trim();
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let hasPair = false;
  const startSection = (): void => {
    cur = { pairOld: null, pairNew: null, renameFrom: null, renameTo: null, diffOld: null, diffNew: null, newFile: false, deletedFile: false, hunks: [] };
    sections.push(cur);
    inHeader = true;
    hasPair = false;
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection();
      cur!.diffOld = m[1]!;
      cur!.diffNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && !hasPair) {
        cur.pairOld = stripAB(headerPath(line));
        cur.pairNew = stripAB(headerPath(lines[i + 1]!));
        hasPair = true;
        i += 2;
        continue;
      }
      startSection();
      cur!.pairOld = stripAB(headerPath(line));
      cur!.pairNew = stripAB(headerPath(lines[i + 1]!));
      hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && inHeader) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    const hm = HUNK_RE.exec(line);
    if (hm !== null) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const body: BodyLine[] = [];
      i++;
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') body.push({ kind: 'ctx', text: '' });
        else if (bl.startsWith(' ')) body.push({ kind: 'ctx', text: bl.slice(1) });
        else if (bl.startsWith('-')) body.push({ kind: 'old', text: bl.slice(1) });
        else if (bl.startsWith('+')) body.push({ kind: 'new', text: bl.slice(1) });
        else if (bl.startsWith('\\')) body.push({ kind: 'bs', text: bl.slice(1) });
        else break;
        i++;
      }
      // Empty lines at the end of a body are not part of it.
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') body.pop();
        else break;
      }
      cur.hunks.push({ a: parseInt(hm[1]!, 10), body });
      continue;
    }
    if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.newFile = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  return sections;
}

/** Apply a section's hunks in order to a file's lines; throws Fail on no-match. */
function applyHunks(f: FileText, hunks: Hunk[], strict: boolean, path: string): FileText {
  let lines = [...f.lines];
  let fin = f.final;
  let d = 0;
  for (const h of hunks) {
    const { o, n, ctx } = hunkON(h.body);
    const li = lastCtxOrNew(h.body);
    const bsAfter = li >= 0 && h.body[li + 1] !== undefined && h.body[li + 1]!.kind === 'bs';
    if (o.length === 0) {
      const pos = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = pos === lines.length;
      lines.splice(pos, 0, ...n);
      if (atEnd) fin = !bsAfter;
      d += n.length;
      continue;
    }
    const found = findTier(lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const pos of found.occ) {
      if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
    }
    const oldLen = lines.length;
    const matchEnd = best + o.length;
    const repl = buildReplacement(lines, best, o, n, ctx, found.tier);
    lines.splice(best, o.length, ...repl);
    if (matchEnd === oldLen) fin = !bsAfter;
    d += n.length - o.length;
  }
  return { br: f.br, lines, final: fin };
}

function unifiedSectionEdit(s: Section, strict: boolean): Edit {
  const oldRaw = s.pairOld ?? s.renameFrom ?? s.diffOld ?? '';
  const newRaw = s.pairNew ?? s.renameTo ?? s.diffNew ?? '';
  const oldP = oldRaw === '/dev/null' ? null : oldRaw;
  const newP = newRaw === '/dev/null' ? null : newRaw;
  const isCreate = oldP === null || s.newFile;
  const isDelete = !isCreate && (newP === null || s.deletedFile);
  const isMove = !isCreate && !isDelete && oldP !== newP;
  return (tree) => {
    if (isCreate) {
      const p = newP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.exists(p)) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      let fin = true;
      if (plus.length === 0) {
        fin = false;
      } else {
        outer: for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
          const body = s.hunks[hi]!.body;
          for (let bi = body.length - 1; bi >= 0; bi--) {
            if (body[bi]!.kind === 'new') {
              fin = !(body[bi + 1] !== undefined && body[bi + 1]!.kind === 'bs');
              break outer;
            }
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (isDelete) {
      const p = oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (isMove) {
      const op = oldP ?? '';
      const np = newP ?? '';
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.exists(np)) throw new Fail('exists', np);
      const f = applyHunks(splitFile(before), s.hunks, strict, op);
      tree.now.set(op, null);
      tree.now.set(np, joinFile(f));
      tree.moves.push({ old: op, new: np });
      return;
    }
    const p = oldP ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, joinFile(applyHunks(splitFile(before), s.hunks, strict, p)));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((s) => unifiedSectionEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7).
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (l.trim() === '') continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return blocks;
}

function searchReplaceEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.oldLines.length === 0) {
      if (tree.exists(p)) throw new Fail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = splitFile(before);
    const found = findTier(f.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const pos = found.occ[0]!;
    const repl = buildReplacement(f.lines, pos, b.oldLines, b.newLines, b.newLines.map(() => -1), found.tier);
    const lines = [...f.lines];
    lines.splice(pos, b.oldLines.length, ...repl);
    tree.now.set(p, joinFile({ br: f.br, lines, final: f.final }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  return parseSearchReplace(lines).map((b) => searchReplaceEdit(b, strict));
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8).
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface RawV4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  raw: Array<{ text: string; num: number }>;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  fileLines: string[];
  moveTo: string | null;
  chunks: V4aChunk[];
}

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const rawSections: RawV4aSection[] = [];
  let cur: RawV4aSection | null = null;
  const flush = (): void => {
    if (cur !== null) {
      while (cur.raw.length > 0 && blank(cur.raw[cur.raw.length - 1]!.text)) cur.raw.pop();
      rawSections.push(cur);
      cur = null;
    }
  };
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      if (cur !== null) cur.raw.push({ text: line, num: i + 1 });
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      flush();
      cur = { kind: 'add', path: line.slice('*** Add File: '.length).trim(), headerLine: i + 1, raw: [] };
      i++;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      flush();
      cur = { kind: 'delete', path: line.slice('*** Delete File: '.length).trim(), headerLine: i + 1, raw: [] };
      i++;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      flush();
      cur = { kind: 'update', path: line.slice('*** Update File: '.length).trim(), headerLine: i + 1, raw: [] };
      i++;
      continue;
    }
    if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
    cur.raw.push({ text: line, num: i + 1 });
    i++;
  }
  flush();
  return rawSections.map(validateV4aSection);
}

function validateV4aSection(s: RawV4aSection): V4aSection {
  if (s.kind === 'add') {
    const fileLines: string[] = [];
    for (const l of s.raw) {
      if (l.text === '') fileLines.push('');
      else if (l.text.startsWith('+')) fileLines.push(l.text.slice(1));
      else throw new Exit2(`error: parse ${l.num}`);
    }
    return { kind: 'add', path: s.path, fileLines, moveTo: null, chunks: [] };
  }
  if (s.kind === 'delete') {
    for (const l of s.raw) {
      if (blank(l.text)) continue;
      throw new Exit2(`error: parse ${l.num}`);
    }
    return { kind: 'delete', path: s.path, fileLines: [], moveTo: null, chunks: [] };
  }
  // Update: an optional `*** Move to:` first, then chunks.
  let idx = 0;
  let moveTo: string | null = null;
  if (s.raw.length > 0 && s.raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = s.raw[0]!.text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let chunkStarted = false;
  for (; idx < s.raw.length; idx++) {
    const { text, num } = s.raw[idx]!;
    if (text.startsWith('@@')) {
      cur = { anchor: text.slice(2).trim(), eof: false, body: [] };
      chunks.push(cur);
      chunkStarted = true;
      continue;
    }
    if (text === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${num}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
      if (cur === null) {
        if (chunkStarted) throw new Exit2(`error: parse ${num}`);
        cur = { anchor: null, eof: false, body: [] };
        chunks.push(cur);
        chunkStarted = true;
      }
      if (text === '') cur.body.push({ kind: 'ctx', text: '' });
      else if (text.startsWith(' ')) cur.body.push({ kind: 'ctx', text: text.slice(1) });
      else if (text.startsWith('-')) cur.body.push({ kind: 'old', text: text.slice(1) });
      else cur.body.push({ kind: 'new', text: text.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${num}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.headerLine}`);
  return { kind: 'update', path: s.path, fileLines: [], moveTo, chunks };
}

/** The first line at or after the cursor equal to the anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

function applyV4aChunk(f: FileText, chunk: V4aChunk, cursor: number, strict: boolean, path: string): { lines: string[]; cursor: number } {
  const lines = [...f.lines];
  let cur = cursor;
  if (chunk.anchor !== null && chunk.anchor !== '') {
    const ai = findAnchor(lines, chunk.anchor, cur, strict);
    if (ai === null) throw new Fail('no-match', path);
    cur = ai + 1;
  }
  const { o, n, ctx } = hunkON(chunk.body);
  if (o.length === 0) {
    const pos = chunk.eof ? lines.length : cur;
    lines.splice(pos, 0, ...n);
    return { lines, cursor: pos + n.length };
  }
  const tiers = strict ? [0] : [0, 1, 2];
  let found: { tier: number; pos: number } | null = null;
  for (const t of tiers) {
    for (let i = cur; i + o.length <= lines.length; i++) {
      if (chunk.eof && i + o.length !== lines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j++) {
        if (!lineEq(lines[i + j]!, o[j]!, t)) {
          ok = false;
          break;
        }
      }
      if (ok) {
        found = { tier: t, pos: i };
        break;
      }
    }
    if (found !== null) break;
  }
  if (found === null) throw new Fail('no-match', path);
  const repl = buildReplacement(lines, found.pos, o, n, ctx, found.tier);
  lines.splice(found.pos, o.length, ...repl);
  return { lines, cursor: found.pos + repl.length };
}

function v4aSectionEdit(s: V4aSection, strict: boolean): Edit {
  return (tree) => {
    const p = s.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (s.kind === 'add') {
      if (tree.exists(p)) throw new Fail('exists', p);
      tree.now.set(p, s.fileLines.length === 0 ? '' : s.fileLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (s.moveTo !== null && tree.exists(s.moveTo)) throw new Fail('exists', s.moveTo);
    let f = splitFile(before);
    let cursor = 0;
    for (const ch of s.chunks) {
      const r = applyV4aChunk(f, ch, cursor, strict, p);
      f = { br: f.br, lines: r.lines, final: f.final };
      cursor = r.cursor;
    }
    const text = joinFile(f);
    if (s.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(s.moveTo, text);
      tree.moves.push({ old: p, new: s.moveTo });
    } else {
      tree.now.set(p, text);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4a(lines).map((s) => v4aSectionEdit(s, strict));
}

// ---------------------------------------------------------------------------
// Running (SPEC.md sections 1, 2 and 10).
// ---------------------------------------------------------------------------

function parsePatch(kind: string, text: string, lines: string[], strict: boolean): Edit[] {
  if (kind === 'json') return jsonEdits(text, lines);
  if (kind === 'unified') return unifiedEdits(lines, strict);
  if (kind === 'search-replace') return searchReplaceEdits(lines, strict);
  return v4aEdits(lines, strict);
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = parsePatch(kind, text, lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const m of tree.moves) {
    if (tree.original(m.old) === null) continue;
    if (tree.get(m.old) !== null) continue;
    if (tree.original(m.new) !== null) continue;
    if (tree.get(m.new) === null) continue;
    const di = rows.findIndex((r) => r.text === `D ${m.old}`);
    const ai = rows.findIndex((r) => r.text === `A ${m.new}`);
    if (di < 0 || ai < 0) continue;
    rows.splice(Math.max(di, ai), 1);
    rows.splice(Math.min(di, ai), 1);
    rows.push({ key: m.new, text: `R ${m.old} -> ${m.new}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    // Deletes first, then writes, so a move never trips over its own old path.
    for (const p of [...tree.now.keys()]) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const out = rows.map((r) => r.text);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
