// API client: bearer token + selected repo (?repo=) + friendly errors.
import { store } from "./dom.js";

export class ApiError extends Error {
  constructor(status, message, path) {
    super(message);
    this.status = status;
    this.path = path;
  }
  /** the endpoint itself does not exist on this server (as opposed to "that file does not exist") */
  get missing() {
    return this.status === 404 && /^no route|^not implemented|^unknown (route|endpoint)/i.test(this.message) || this.status === 501 || this.status === 405;
  }
  get unauthorized() {
    return this.status === 401;
  }
  get forbidden() {
    return this.status === 403;
  }
}

export const session = {
  get token() {
    return store.get("weave.token") || "";
  },
  set token(v) {
    v ? store.set("weave.token", v) : store.del("weave.token");
  },
  get repo() {
    return store.get("weave.repo") || "default";
  },
  set repo(v) {
    store.set("weave.repo", v || "default");
  },
  get name() {
    return store.get("weave.name") || "";
  },
  set name(v) {
    v ? store.set("weave.name", v) : store.del("weave.name");
  },
};

const listeners = { unauthorized: new Set() };
export const onUnauthorized = (fn) => listeners.unauthorized.add(fn);

function url(path, query) {
  const u = new URL("/api/" + path.replace(/^\/+/, ""), location.origin);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
  if (!u.searchParams.has("repo") && session.repo !== "default") u.searchParams.set("repo", session.repo);
  return u.pathname + u.search;
}

/** api("tree", {query:{path}}) / api("tasks", {method:"POST", body}) */
export async function api(path, { method = "GET", body, query, signal, repo } = {}) {
  const headers = { accept: "application/json" };
  if (session.token) headers.authorization = "Bearer " + session.token;
  if (body !== undefined) headers["content-type"] = "application/json";
  const q = repo ? { ...query, repo } : query;
  let res;
  try {
    res = await fetch(url(path, q), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal, cache: "no-store" });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new ApiError(0, "Cannot reach the server. Check your connection and try again.", path);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data && typeof data.error === "string" && data.error) || (res.status === 404 ? "not implemented: " + path : `request failed (${res.status})`);
    const err = new ApiError(res.status, msg, path);
    if (res.status === 401) for (const fn of listeners.unauthorized) fn(err);
    throw err;
  }
  if (data === null && text) throw new ApiError(res.status, "The server returned something that is not JSON.", path);
  return data;
}

/** Resolve to null when the endpoint is missing on this server (404 "no route"); rethrow everything else. */
export async function optional(promise) {
  try {
    return await promise;
  } catch (e) {
    if (e instanceof ApiError && e.missing) return null;
    throw e;
  }
}

export const isAbort = (e) => e?.name === "AbortError";
export const post = (path, body = {}, opts = {}) => api(path, { ...opts, method: "POST", body });
