// Export trunk history as a `git fast-import` stream, so Weave work can flow back into plain Git:
//   curl localhost:8787/api/export | git -C some-repo fast-import
import type { State } from "./repo.ts";

const enc = new TextEncoder();

export function exportFastImport(s: State, branch = "main"): string {
  const out: string[] = [];
  const data = (text: string) => `data ${enc.encode(text).length}\n${text}\n`;
  let prev = 0;
  for (const c of s.commits) {
    const who = c.agent.replace(/[<>\n]/g, "");
    const ident = `${who} <${who.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@weave.agents> ${Math.floor(c.ts / 1000)} +0000`;
    const msg = `${c.message}\n\nWeave-Session: ${c.sessionId}\nWeave-Rev: r${c.rev}${c.merged ? "\nWeave-Merged: concurrent changes auto-merged" : ""}`;
    out.push(`commit refs/heads/${branch}\nmark :${c.rev}\nauthor ${ident}\ncommitter ${ident}\n${data(msg)}`);
    if (prev) out.push(`from :${prev}\n`);
    for (const p of c.paths) {
      const v = s.files[p]?.find((f) => f.rev === c.rev);
      if (!v || v.content === null) out.push(`D ${p}\n`);
      else out.push(`M 100644 inline ${p}\n${data(v.content)}`);
    }
    out.push("\n");
    prev = c.rev;
  }
  return out.join("");
}
