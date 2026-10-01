// Replays the scenario against a running Weave (default: wrangler dev on :8787).
//   node scripts/demo.ts [baseUrl]
import { SCENARIO } from "../src/scenario.ts";

const base = process.argv[2] ?? "http://localhost:8787";
const call = async (m: string, p: string, b?: unknown) => {
  const r = await fetch(`${base}/api/${p}`, { method: m, headers: { "content-type": "application/json" }, body: b ? JSON.stringify(b) : undefined });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`${m} ${p}: ${j.error}`);
  return j;
};

await call("POST", "reset", {});
for (const st of SCENARIO) {
  if (st.op === "note") console.log(`\n# ${st.text}`);
  else if (st.op === "open") console.log(`${st.agent} opens session: ${st.goal}`), await call("POST", "sessions", st);
  else if (st.op === "write") await call("POST", `sessions/${st.id}/file`, st);
  else if (st.op === "submit") console.log(`  submit ${st.id} ->`, (await call("POST", `sessions/${st.id}/submit`, st)).status);
  else if (st.op === "resolve") console.log(`  resolve ${st.id}:${st.path} (${st.how})`), await call("POST", `sessions/${st.id}/resolve`, st);
  else if (st.op === "verify") console.log(`  verify ${st.id} ->`, (await call("POST", `sessions/${st.id}/verify`, st)).status);
  else if (st.op === "review") console.log(`  review ${st.id} ->`, (await call("POST", `sessions/${st.id}/review`, st)).status);
}
const s = await call("GET", "state");
console.log(`\nTrunk is at r${s.rev}. Event log:`);
for (const e of s.events) console.log(`  [${e.type}] ${e.message}`);
