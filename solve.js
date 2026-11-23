// Faster makefun-site: a from-scratch drop-in for makefun-site 1.0.0.
// run(input) returns exactly the output tree makefun-site's build returns
// for the same input, byte for byte — but faster: a single-pass Markdown
// renderer, range-based inline rendering, a memoised slugifier and a tight
// template interpreter. The semantics follow makefun-site's README and its
// reference behaviour; the code below is my own writing.
//
// One run() call is one build. Nothing is kept from one case to the next:
// every cache below lives inside a single run() invocation.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `s[a..b)` with & < > " ' escaped, pushed onto `out`. */
function escRange(out, s, a, b) {
  if (a >= b) return;
  out.push(s.slice(a, b).replace(ESC_RE, (c) => ESCAPES[c]));
}

/** A whole string escaped. */
function escStr(s) {
  return s.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** Code-unit order (never the locale's). */
function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const MARK_RE = /\p{M}/gu;
const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. Results are memoised per run: titles and tag names repeat a lot.
 */
function makeSlugify() {
  const cache = new Map();
  return function slugify(text) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const plain = text.normalize('NFKD').replace(MARK_RE, '');
    let out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    if (out === '') out = 'untitled';
    cache.set(text, out);
    return out;
  };
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function fmString(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  if (key === 'title' || key === 'summary') {
    const s = fmString(raw);
    return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
  }
  if (key === 'date') {
    const m = FM_DATE.exec(raw);
    const y = m ? Number(m[1]) : 0;
    const mo = m ? Number(m[2]) : 0;
    const d = m ? Number(m[3]) : 0;
    if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
      return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
    const inner = raw.slice(1, -1);
    if (inner.trim() === '') return { value: [] };
    const tags = inner.split(',');
    for (let i = 0; i < tags.length; i++) tags[i] = tags[i].trim();
    for (const t of tags) {
      if (t === '' || !FM_TAG.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
    }
    return { value: tags };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  // slug
  return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
}

/** Whether a line holds only spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends.
 */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    const m = FM_LINE.exec(line);
    if (m === null) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] === undefined ? '' : m[2]).replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- Markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;
const WS_RE = /\s/;

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** A heading line's depth and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING_RE.exec(line);
  if (m === null || m[2] === '') return null;
  return { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: blank, fence, heading or thematic break. */
function endsParagraph(line) {
  return isBlank(line) || FENCE_OPEN.test(line) || headingOf(line) !== null || HR_RE.test(line);
}

/** A line trimmed of spaces and tabs at both ends (the line itself when it has none). */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from, to) {
  const wlen = what.length;
  for (let j = from; j <= to - wlen; j++) {
    if (s[j] === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, to) {
  for (let j = from; j < to; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < to && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < to && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const INLINE_MARK_RE = /[\\`*[]/g;

/** The next index from `from` where `s` holds a character that starts an inline construct, or -1. */
function nextMark(s, from, to) {
  INLINE_MARK_RE.lastIndex = from;
  const m = INLINE_MARK_RE.exec(s);
  if (m === null || m.index >= to) return -1;
  return m.index;
}

/**
 * `s[a..b)` rendered inline into `out`; `link(target)` resolves a link's
 * href. Plain runs are escaped in bulk and the scan jumps natively from one
 * markup character to the next; nested spans work on ranges, so no
 * substring is cut for a nested span.
 */
function inlineInto(out, s, a, b, link) {
  let i = a;
  while (i < b) {
    const m = nextMark(s, i, b);
    if (m === -1) {
      escRange(out, s, i, b);
      return;
    }
    if (m > i) escRange(out, s, i, m);
    i = m;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < b && ESCAPABLE.has(s[i + 1])) {
        const n = s[i + 1];
        out.push(n === '>' ? '&gt;' : n);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        out.push('<code>');
        escRange(out, s, i + 1, j);
        out.push('</code>');
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (c === '*') {
      if (i + 1 < b && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j > i + 2) {
          out.push('<strong>');
          inlineInto(out, s, i + 2, j, link);
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i += 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j > i + 1) {
        out.push('<em>');
        inlineInto(out, s, i + 1, j, link);
        out.push('</em>');
        i = j + 1;
      } else {
        out.push('*');
        i++;
      }
      continue;
    }
    // '['
    const k = findUnescaped(s, ']', i + 1, b);
    let q = -1;
    if (k !== -1 && k + 1 < b && s[k + 1] === '(') q = s.indexOf(')', k + 2);
    if (q !== -1 && q < b) {
      const target = s.slice(k + 2, q);
      if (target !== '' && !WS_RE.test(target)) {
        const href = link(target);
        out.push('<a href="');
        escRange(out, href, 0, href.length);
        out.push('">');
        inlineInto(out, s, i + 1, k, link);
        out.push('</a>');
        i = q + 1;
        continue;
      }
    }
    out.push('[');
    i++;
  }
}

/** `s` rendered inline as a string. */
function inlineStr(s, link) {
  const out = [];
  inlineInto(out, s, 0, s.length, link);
  return out.join('');
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents (every level 2 and 3 heading) and
 * its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link, slugify) {
  const lines = src.split('\n');
  const n = lines.length;
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      const body = [];
      i++;
      while (i < n && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      const cls = fence[1] === '' ? '' : ` class="language-${escStr(fence[1])}"`;
      const code = body.length === 0 ? '' : `${escStr(body.join('\n'))}\n`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>\n`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inlineStr(heading.text, link);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      blocks.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      if (kept.length === 0) blocks.push('<blockquote>\n</blockquote>\n');
      else blocks.push(`<blockquote>\n<p>${inlineStr(kept.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = BULLET_RE.exec(line);
    const ordered = bullet === null ? ORDERED_RE.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED_RE : BULLET_RE;
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (CONTINUED_RE.test(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const start = isOrdered ? Number(ordered[1]) : 1;
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      const out = [open, '\n'];
      for (const parts of items) {
        out.push('<li>', inlineStr(parts.join('\n'), link), '</li>\n');
      }
      out.push(`</${tag}>\n`);
      blocks.push(out.join(''));
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inlineStr(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------------------------------------------------------------- Templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isBlank(src.slice(lineStart, open)) && isBlank(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null ? parent.else : parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let out = '';
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out += ', ';
      out += textOf(v[i]);
    }
    return out;
  }
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out`, in scope ({ vars, parent }). `ctx` holds the
 * parsed templates, the HTML escape and nothing else; `depth` counts
 * includes.
 */
function renderInto(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    if (n.kind === 'text') {
      out.push(n.text);
    } else if (n.kind === 'var') {
      out.push(escStr(textOf(lookup(scope, n.path))));
    } else if (n.kind === 'raw') {
      out.push(textOf(lookup(scope, n.path)));
    } else if (n.kind === 'if') {
      const branch = truthy(lookup(scope, n.path)) !== n.not ? n.then : n.else;
      if (branch !== null) renderInto(branch, scope, ctx, depth, out);
    } else if (n.kind === 'for') {
      const xs = lookup(scope, n.path);
      if (Array.isArray(xs)) {
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderInto(n.body, { vars, parent: scope }, ctx, depth, out);
        }
      }
    } else if (n.kind === 'include') {
      const t = ctx.templates.get(n.name);
      if (t !== undefined && depth < INCLUDE_DEPTH) renderInto(t, scope, ctx, depth + 1, out);
    }
  }
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];

/**
 * The words of a body: its runs of characters other than whitespace. The
 * whitespace set is JavaScript's \s, checked by code point so no regex and
 * no word array is ever built.
 */
function countWords(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c <= 32 || c === 160 || c === 5760 || (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugify = makeSlugify();
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (err instanceof TemplateError) report.push(err.message);
      else throw err;
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const broken = new Set();
  const output = {};

  // 1. Sources, in code-unit order of path; .md is a source, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout !== undefined ? s.data.layout : s.post ? 'post' : 'page';
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  const pages = kept;

  // 3. Permalinks: each page's directory, slug (unique in it), url.
  const taken = new Map();
  const bySource = new Map();
  for (const s of pages) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let takenIn = taken.get(dir);
    if (takenIn === undefined) {
      takenIn = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, takenIn);
    }
    const slug = uniqueSlug(s.data.slug !== undefined ? s.data.slug : slugify(s.data.title), takenIn);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Markdown: each body's HTML, its links resolved.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  for (const s of pages) {
    const dir = dirOf(s.path);
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, equal dates by slug; newer/older neighbours.
  const posts = [];
  for (const s of pages) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags: grouped by slug, each named as first met in the posts' order.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    const names = p.data.tags !== undefined ? p.data.tags : [];
    for (const name of names) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of pages) {
    if (s.post) continue;
    const refs = [];
    const seen = new Set();
    const names = s.data.tags !== undefined ? s.data.tags : [];
    for (const name of names) {
      const slug = slugify(name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      refs.push(bySlug.get(slug) !== undefined ? bySlug.get(slug) : { name, slug, url: '', posts: [] });
    }
    s.tagRefs = refs;
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Layouts: every page through its layout, the index and tag pages.
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary !== undefined ? s.data.summary : '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const linkOf = (s) => (s === null ? null : {
    title: s.data.title,
    url: s.url,
    date: s.data.date !== undefined ? s.data.date : '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderInto(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of pages) {
    const card = s.post ? cards.get(s) : cardOf(s);
    const page = {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer !== undefined ? s.newer : null),
      older: linkOf(s.older !== undefined ? s.older : null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pageCount, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pageCount ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every line reported above and each broken link, sorted,
  // then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageTotal = 0;
  for (const s of pages) if (!s.post) pageTotal++;
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}



