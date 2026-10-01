// Safe Markdown: parses to a plain-object AST (tags from a fixed whitelist, text as strings) and only
// then builds DOM nodes with createElement/textContent. Raw HTML in the source is never interpreted:
// it is kept as literal text. Links are limited to http(s) and relative URLs.

const TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "code", "ul", "ol", "li", "blockquote", "hr", "br", "em", "strong", "del", "a", "table", "thead", "tbody", "tr", "th", "td"]);
const ATTRS = { a: ["href", "rel", "target"], code: ["class"], ol: ["start"], th: ["class"], td: ["class"] };

/** Returns a safe URL string or null. Allows http(s) and relative references only. */
export function safeUrl(raw) {
  if (typeof raw !== "string") return null;
  const u = raw.replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, "");
  if (!u) return null;
  if (/^[\\/]{2}/.test(u) || u.startsWith("\\")) return null; // protocol-relative / backslash hosts
  if (/^[^/?#]*:/.test(u)) return /^https?:/i.test(u) ? u : null; // any other scheme is rejected
  return u;
}

const el = (tag, children = [], attrs) => ({ tag, attrs, children });
const link = (href, children) => el("a", children, /^https?:/i.test(href) ? { href, rel: "noopener noreferrer nofollow", target: "_blank" } : { href });

// ---------------------------------------------------------------------------------- inline
function inline(src, depth = 0) {
  const out = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const rest = () => src.slice(i);
    if (ch === "\\" && i + 1 < src.length && /[\\`*_{}\[\]()#+\-.!|~<>]/.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest());
      if (m) {
        flush();
        out.push(el("code", [m[2].replace(/^ (.*) $/, "$1")]));
        i += m[0].length;
        continue;
      }
    }
    if (ch === "[" && depth < 4) {
      const m = /^\[((?:[^\[\]\\]|\\.)*)\]\(\s*([^\s)]*)(?:\s+"[^"]*")?\s*\)/.exec(rest());
      if (m) {
        const href = safeUrl(m[2]);
        flush();
        if (href) out.push(link(href, inline(m[1], depth + 1)));
        else out.push(...inline(m[1], depth + 1), " (link removed)");
        i += m[0].length;
        continue;
      }
    }
    if (ch === "!" && src[i + 1] === "[") {
      const m = /^!\[([^\]]*)\]\(([^)]*)\)/.exec(rest()); // images are not rendered: show the alt text
      if (m) {
        flush();
        out.push(`[image: ${m[1]}]`);
        i += m[0].length;
        continue;
      }
    }
    if (ch === "<") {
      const m = /^<(https?:\/\/[^\s<>]+)>/i.exec(rest());
      if (m && safeUrl(m[1])) {
        flush();
        out.push(link(m[1], [m[1]]));
        i += m[0].length;
        continue;
      }
    }
    if ((ch === "h" || ch === "H") && /^https?:\/\//i.test(src.slice(i, i + 8)) && (i === 0 || /[\s(]/.test(src[i - 1]))) {
      const m = /^https?:\/\/[^\s<>]*[^\s<>.,;:!?)\]'"]/i.exec(rest());
      if (m && safeUrl(m[0])) {
        flush();
        out.push(link(m[0], [m[0]]));
        i += m[0].length;
        continue;
      }
    }
    const emph = /^(\*\*|__|~~|\*|_)(?=\S)/.exec(rest());
    if (emph && depth < 4 && (emph[1][0] !== "_" || i === 0 || /[\s(]/.test(src[i - 1]))) {
      const d = emph[1];
      let j = src.indexOf(d, i + d.length);
      while (j !== -1 && (/\s/.test(src[j - 1]) || (d[0] === "_" && /\w/.test(src[j + d.length] ?? "")))) j = src.indexOf(d, j + 1);
      if (j > i + d.length) {
        flush();
        out.push(el(d === "**" || d === "__" ? "strong" : d === "~~" ? "del" : "em", inline(src.slice(i + d.length, j), depth + 1)));
        i = j + d.length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------------- blocks
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+.#-]*)[^`]*$/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const HR = /^ {0,3}([-*_])( ?\1){2,}\s*$/;
const splitRow = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
const isSep = (l) => /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(l) && (l.includes("|") || /^\s*:?-+:?\s*$/.test(l));
const ind = (l) => /^\s*/.exec(l)[0].length;

function blocks(lines, depth = 0) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    let m = FENCE.exec(line);
    if (m) {
      const fence = m[1];
      const body = [];
      i++;
      while (i < lines.length && !(new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[i]))) body.push(lines[i++]);
      i++;
      const lang = /^[\w+.#-]{1,20}$/.test(m[2]) ? m[2] : "";
      out.push(el("pre", [el("code", [body.join("\n")], lang ? { class: "lang-" + lang } : undefined)]));
      continue;
    }
    if ((m = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      out.push(el("h" + m[1].length, inline(m[2])));
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push(el("hr"));
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) q.push(lines[i++].replace(/^\s{0,3}> ?/, ""));
      out.push(el("blockquote", depth > 6 ? [q.join("\n")] : blocks(q, depth + 1)));
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && isSep(lines[i + 1]) && splitRow(line).length > 1) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-:$/.test(c) ? "right" : ""));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(splitRow(lines[i++]));
      const cell = (tag, c, k) => el(tag, inline(c), align[k] ? { class: "al-" + align[k] } : undefined);
      out.push(el("table", [el("thead", [el("tr", head.map((c, k) => cell("th", c, k)))]), el("tbody", rows.map((r) => el("tr", head.map((_, k) => cell("td", r[k] ?? "", k)))))]));
      continue;
    }
    if ((m = LIST.exec(line))) {
      const ordered = /\d/.test(m[2]);
      const base = m[1].length;
      const start = ordered ? parseInt(m[2], 10) : 1;
      const items = [];
      while (i < lines.length) {
        const lm = LIST.exec(lines[i]);
        if (lm && lm[1].length === base && /\d/.test(lm[2]) === ordered) {
          const item = { text: [lm[3]], rest: [] };
          i++;
          while (i < lines.length && lines[i].trim()) {
            const l = lines[i];
            const lm2 = LIST.exec(l);
            if (lm2 && lm2[1].length <= base) break;
            if (ind(l) > base) {
              if (lm2 || item.rest.length) item.rest.push(l.slice(Math.min(ind(l), base + 2)));
              else item.text.push(l.trim());
            } else if (FENCE.test(l) || /^\s*#/.test(l) || HR.test(l) || /^\s*>/.test(l)) break;
            else item.text.push(l.trim());
            i++;
          }
          items.push(item);
        } else if (!lines[i].trim() && i + 1 < lines.length && LIST.exec(lines[i + 1]) && LIST.exec(lines[i + 1])[1].length === base) i++;
        else break;
      }
      const li = items.map((it) => {
        let t = it.text.join("\n");
        let box = "";
        const tm = /^\[( |x|X)\]\s+/.exec(t);
        if (tm) {
          box = tm[1] === " " ? "☐ " : "☑ ";
          t = t.slice(tm[0].length);
        }
        return el("li", [box, ...inline(t), ...(it.rest.length && depth < 8 ? blocks(it.rest, depth + 1) : [])]);
      });
      out.push(el(ordered ? "ol" : "ul", li, ordered && start !== 1 ? { start: String(start) } : undefined));
      continue;
    }
    // paragraph
    const p = [];
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !/^ {0,3}#{1,6}\s/.test(lines[i]) && !/^\s{0,3}>/.test(lines[i]) && !HR.test(lines[i])) {
      if (p.length && (LIST.test(lines[i]) || (lines[i].includes("|") && isSep(lines[i + 1] ?? "")))) break;
      p.push(lines[i++]);
    }
    if (!p.length) p.push(lines[i++]);
    const kids = [];
    p.forEach((l, k) => {
      const last = k === p.length - 1;
      const hard = !last && /( {2,}|\\)$/.test(l);
      kids.push(...inline(l.replace(/( {2,}|\\)$/, "").trim() + (!last && !hard ? "\n" : "")));
      if (hard) kids.push(el("br"));
    });
    out.push(el("p", kids));
  }
  return out;
}

/** Markdown source -> AST (arrays of strings and {tag, attrs, children}). */
export function parseMarkdown(src) {
  return blocks(String(src ?? "").replace(/\r\n?/g, "\n").split("\n"));
}

/** AST -> DOM nodes in `doc` (default: global document). Only whitelisted tags/attributes are created. */
export function astToDom(nodes, doc = globalThis.document) {
  const frag = doc.createDocumentFragment();
  for (const n of nodes) {
    if (typeof n === "string") frag.appendChild(doc.createTextNode(n));
    else if (TAGS.has(n.tag)) {
      const e = doc.createElement(n.tag);
      for (const [k, v] of Object.entries(n.attrs ?? {})) if ((ATTRS[n.tag] ?? []).includes(k)) e.setAttribute(k, String(v));
      e.appendChild(astToDom(n.children ?? [], doc));
      frag.appendChild(e);
    }
  }
  return frag;
}

export const renderMarkdown = (src, doc) => astToDom(parseMarkdown(src), doc);

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Serialise the AST to an HTML string (for tests and debugging only; the app never uses it). */
export function astToHtml(nodes) {
  return nodes
    .map((n) => {
      if (typeof n === "string") return esc(n);
      if (!TAGS.has(n.tag)) return "";
      const at = Object.entries(n.attrs ?? {}).filter(([k]) => (ATTRS[n.tag] ?? []).includes(k)).map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
      return n.tag === "br" || n.tag === "hr" ? `<${n.tag}${at}>` : `<${n.tag}${at}>${astToHtml(n.children ?? [])}</${n.tag}>`;
    })
    .join("");
}
