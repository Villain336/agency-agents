// Hash router (pure parsing/building; the DOM glue lives in app.js).
// Hash shape:  #/<route>/<arg...>[?query][#fragment]   e.g.  #/blob/src/a.ts?rev=4#L12

const SIMPLE = ["changes", "tasks", "commits", "search", "activity", "releases", "notifications", "settings", "repos"];
const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

export function parseHash(hash) {
  let h = String(hash ?? "").replace(/^#/, "");
  let frag = "";
  const f = h.indexOf("#");
  if (f >= 0) {
    frag = h.slice(f + 1);
    h = h.slice(0, f);
  }
  let qs = "";
  const q = h.indexOf("?");
  if (q >= 0) {
    qs = h.slice(q + 1);
    h = h.slice(0, q);
  }
  const query = {};
  for (const [k, v] of new URLSearchParams(qs)) query[k] = v;
  const segs = h.split("/").filter(Boolean).map(safeDecode);
  const base = { query, frag, params: {} };
  if (!segs.length) return { ...base, name: "home", params: { path: "" } };
  const [head, ...rest] = segs;
  if (head === "tree" || head === "blob") return { ...base, name: head, params: { path: rest.join("/") } };
  if (head === "commit" && rest.length) return { ...base, name: "commit", params: { rev: rest[0] } };
  if (head === "change" && rest.length) return { ...base, name: "change", params: { id: rest.join("/") } };
  if (head === "task" && rest.length) return { ...base, name: "task", params: { n: rest[0] } };
  if (SIMPLE.includes(head) && !rest.length) return { ...base, name: head };
  return { ...base, name: "notfound", params: { path: segs.join("/") } };
}

const enc = (p) => String(p).split("/").map(encodeURIComponent).join("/");
export function buildHash(name, params = {}, query = {}, frag = "") {
  let p;
  switch (name) {
    case "home": p = "/"; break;
    case "tree": p = params.path ? "/tree/" + enc(params.path) : "/"; break;
    case "blob": p = "/blob/" + enc(params.path ?? ""); break;
    case "commit": p = "/commit/" + encodeURIComponent(params.rev); break;
    case "change": p = "/change/" + enc(params.id); break;
    case "task": p = "/task/" + encodeURIComponent(params.n); break;
    default: p = "/" + name;
  }
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
  return "#" + p + (qs ? "?" + qs : "") + (frag ? "#" + frag : "");
}

/** Parse "L12" or "L12-L20" fragments. */
export function parseLineFrag(frag) {
  const m = /^L(\d+)(?:-L?(\d+))?$/.exec(frag ?? "");
  return m ? { from: +m[1], to: +(m[2] ?? m[1]) } : null;
}

/** Top-level nav section a route belongs to (for aria-current). */
export const sectionOf = (name) => ({ home: "code", tree: "code", blob: "code", commit: "commits", commits: "commits", change: "changes", task: "tasks" })[name] ?? name;
