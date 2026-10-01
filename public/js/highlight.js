// Small regex-based syntax highlighter. highlight(code, lang) -> array of lines, each an array of
// {c: cssClass|null, t: text}. Pure: the caller builds DOM with textContent. Tokens may span lines
// (block comments, template strings) and are split at newlines afterwards.

const words = (s) => "\\b(?:" + s.trim().split(/\s+/).join("|") + ")\\b";
const JS_KW = "as async await break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of package private protected public readonly return set static super switch this throw try type typeof var void while with yield declare abstract namespace satisfies keyof";
const JS = [
  ["com", String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|(?![\s\S]))`],
  ["str", String.raw`"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|` + "`(?:[^`\\\\]|\\\\[\\s\\S])*`?"],
  ["rx", String.raw`(?<=[(,=:\[!&|?{};]\s*)\/(?![*/])(?:[^/\\\n\[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[dgimsuyv]*`],
  ["lit", words("true false null undefined NaN Infinity")],
  ["kw", words(JS_KW)],
  ["num", String.raw`\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?n?)\b`],
  ["fn", String.raw`[A-Za-z_$][\w$]*(?=\s*\()`],
  ["type", String.raw`\b[A-Z][\w$]*\b`],
];
const PY_KW = "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case";
const PY = [
  ["com", String.raw`#[^\n]*`],
  ["str", String.raw`(?:[rbfRBF]{0,2})(?:"""[\s\S]*?(?:"""|(?![\s\S]))|'''[\s\S]*?(?:'''|(?![\s\S]))|"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)`],
  ["lit", words("True False None")],
  ["kw", words(PY_KW)],
  ["num", String.raw`\b\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?\b`],
  ["fn", String.raw`[A-Za-z_]\w*(?=\s*\()`],
  ["type", String.raw`\b[A-Z]\w*\b`],
];
const SH = [
  ["com", String.raw`(?<![\w$])#[^\n]*`],
  ["str", String.raw`"(?:[^"\\]|\\[\s\S])*"?|'[^']*'?`],
  ["var", String.raw`\$(?:\{[^}\n]*\}?|[A-Za-z_]\w*|[0-9@#?$!*-])`],
  ["kw", words("if then else elif fi for while until do done case esac function in return exit local export readonly set unset source select time")],
  ["num", String.raw`\b\d+\b`],
  ["fn", String.raw`(?<=^|[;&|(]\s*)[a-zA-Z_][\w.-]*(?=\s)`],
  ["opt", String.raw`(?<=\s)--?[A-Za-z][\w-]*`],
];
const JSON_ = [
  ["key", String.raw`"(?:[^"\\\n]|\\.)*"(?=\s*:)`],
  ["str", String.raw`"(?:[^"\\\n]|\\.)*"?`],
  ["lit", words("true false null")],
  ["num", String.raw`-?\b\d+\.?\d*(?:[eE][+-]?\d+)?\b`],
];
const CSS = [
  ["com", String.raw`\/\*[\s\S]*?(?:\*\/|(?![\s\S]))`],
  ["str", String.raw`"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?`],
  ["kw", String.raw`@[\w-]+`],
  ["var", String.raw`--[\w-]+`],
  ["key", String.raw`[\w-]+(?=\s*:(?!:)[^{}]*[;}])`],
  ["num", String.raw`#[\da-fA-F]{3,8}\b|-?\b\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch)?\b`],
  ["type", String.raw`(?<![\w-])[.#][\w-]+|(?<![\w-:])(?:html|body|a|p|div|span|h[1-6]|ul|li|table|tr|td|th|button|input|pre|code|main|header|nav|footer|section|img)\b(?=[^;{}]*\{)`],
];
const HTML = [
  ["com", String.raw`<!--[\s\S]*?(?:-->|(?![\s\S]))`],
  ["kw", String.raw`<!DOCTYPE[^>]*>`],
  ["str", String.raw`"[^"\n]*"?|'[^'\n]*'?`],
  ["tag", String.raw`<\/?[A-Za-z][\w:-]*|\/?>`],
  ["key", String.raw`[\w:@.-]+(?==)`],
  ["var", String.raw`&[#\w]+;`],
];
const MD = [
  ["com", String.raw`^(?:\`\`\`|~~~)[^\n]*(?:\n[\s\S]*?\n(?:\`\`\`|~~~)[^\n]*|[\s\S]*)$`],
  ["kw", String.raw`^#{1,6}\s[^\n]*`],
  ["str", String.raw`\`[^\`\n]+\``],
  ["fn", String.raw`\[[^\]\n]*\]\([^)\n]*\)`],
  ["type", String.raw`\*\*[^*\n]+\*\*|__[^_\n]+__`],
  ["lit", String.raw`^\s*(?:[-*+]|\d+\.)\s`],
  ["com2", String.raw`^>[^\n]*`],
];

const LANGS = { js: JS, ts: JS, jsx: JS, tsx: JS, mjs: JS, cjs: JS, javascript: JS, typescript: JS, py: PY, python: PY, sh: SH, bash: SH, shell: SH, zsh: SH, json: JSON_, jsonc: JSON_, css: CSS, html: HTML, htm: HTML, xml: HTML, svg: HTML, md: MD, markdown: MD, yml: null, yaml: null };
const compiled = new Map();
function rules(lang) {
  const key = String(lang ?? "").toLowerCase();
  if (compiled.has(key)) return compiled.get(key);
  const spec = LANGS[key];
  let r = null;
  if (spec) {
    try {
      r = spec.map(([c, src]) => [c, new RegExp(src, "ym")]);
    } catch {
      r = null; // an engine without lookbehind etc.: degrade to plain text
    }
  }
  compiled.set(key, r);
  return r;
}

export const supportedLanguages = () => Object.keys(LANGS).filter((k) => LANGS[k]);
export const MAX_HIGHLIGHT = 200_000;

/** Tokenise a whole text into [{c,t}] (tokens can contain newlines). */
export function tokenize(code, lang) {
  const rs = code.length > MAX_HIGHLIGHT ? null : rules(lang);
  if (!rs) return [{ c: null, t: code }];
  const out = [];
  let plain = 0;
  let i = 0;
  const push = (c, a, b) => out.push({ c, t: code.slice(a, b) });
  outer: while (i < code.length) {
    for (const [c, re] of rs) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (m && m[0].length) {
        if (plain < i) push(null, plain, i);
        push(c, i, i + m[0].length);
        i += m[0].length;
        plain = i;
        continue outer;
      }
    }
    i++;
  }
  if (plain < code.length) push(null, plain, code.length);
  return out;
}

/** Highlight and split into lines. `highlight("a\nb", "js")` -> [[{c,t}], [{c,t}]]. */
export function highlight(code, lang) {
  const lines = [[]];
  for (const tok of tokenize(String(code ?? ""), lang)) {
    const parts = tok.t.split("\n");
    parts.forEach((p, k) => {
      if (k > 0) lines.push([]);
      if (p) lines[lines.length - 1].push({ c: tok.c, t: p });
    });
  }
  return lines;
}

/** Map a file path to a language id understood by highlight(). */
export function langOf(path, hint) {
  if (hint && hint !== "text" && LANGS[hint]) return hint;
  const m = /\.([A-Za-z0-9]+)$/.exec(path ?? "");
  const ext = m ? m[1].toLowerCase() : "";
  if (LANGS[ext]) return ext;
  if (/(^|\/)(Dockerfile|Makefile)$/.test(path ?? "")) return "sh";
  return "text";
}
