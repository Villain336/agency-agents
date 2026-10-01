import { DurableObject } from "cloudflare:workers";

export interface RepoEntry {
  name: string;
  description: string;
  createdBy: string;
  createdAt: number;
  forkedFrom?: { repo: string; rev: number };
}

export const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A single global index of repositories: names, descriptions, and fork lineage. */
export class RegistryDO extends DurableObject {
  async list(): Promise<RepoEntry[]> {
    const m = await this.ctx.storage.list<RepoEntry>({ prefix: "r:" });
    return [...m.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  async get(name: string): Promise<RepoEntry | null> {
    return (await this.ctx.storage.get<RepoEntry>("r:" + name)) ?? null;
  }
  /** Registers a name; false if it is taken. Atomic (a Durable Object is single-threaded). */
  async register(e: RepoEntry): Promise<boolean> {
    if (await this.ctx.storage.get("r:" + e.name)) return false;
    await this.ctx.storage.put("r:" + e.name, e);
    return true;
  }
  async unregister(name: string): Promise<void> {
    await this.ctx.storage.delete("r:" + name);
  }
}
