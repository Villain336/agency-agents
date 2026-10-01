export const DASHBOARD = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Weave</title>
<style>
:root{--bg:#0f1115;--card:#171a21;--line:#2a2f3a;--fg:#e6e8ee;--dim:#8b93a5;--ok:#3ecf8e;--warn:#f5a524;--bad:#f0616d;--acc:#f6821f}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
header{display:flex;align-items:center;gap:16px;padding:14px 20px;border-bottom:1px solid var(--line)}
h1{font-size:18px;margin:0;color:var(--acc)}header span{color:var(--dim)}button{background:var(--acc);color:#111;border:0;border-radius:6px;padding:7px 14px;font-weight:600;cursor:pointer}
button.ghost{background:transparent;color:var(--fg);border:1px solid var(--line)}button:disabled{opacity:.5}
main{display:grid;grid-template-columns:2fr 1fr;gap:16px;padding:16px 20px}@media(max-width:900px){main{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:12px}
h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:0 0 10px}
.lanes{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.lane{border:1px solid var(--line);border-radius:8px;padding:10px;background:#12151b}.lane b{display:block}.lane small{color:var(--dim)}
.pill{display:inline-block;font-size:11px;border-radius:99px;padding:1px 8px;margin-top:6px;border:1px solid currentColor}
.active{color:#6ea8fe}.landed{color:var(--ok)}.conflicted{color:var(--bad)}.in_review{color:var(--warn)}.rejected{color:var(--dim)}
.ev{padding:5px 0;border-bottom:1px solid var(--line);font-size:13px}.ev:last-child{border:0}.ev i{color:var(--dim);font-style:normal;margin-right:6px}
.t-landed{color:var(--ok)}.t-conflict{color:var(--bad)}.t-overlap,.t-review_requested{color:var(--warn)}
.note{background:#241a0d;border:1px solid #5b3a10;color:#ffd699;border-radius:8px;padding:8px 12px;margin-bottom:12px;min-height:38px}
pre{margin:0;white-space:pre-wrap;color:#c9d1e3;font-size:12px}details{margin:6px 0}summary{cursor:pointer;color:var(--acc)}
</style></head><body>
<header><h1>Weave</h1><span>many agents, one trunk, zero branches</span><span id="rev"></span><span style="flex:1"></span>
<button id="run">&#9654; Run multi-agent demo</button><button class="ghost" id="reset">Reset</button></header>
<main><section>
<div class="note" id="note">Press <b>Run multi-agent demo</b>. Five agents will change the same repo concurrently.</div>
<div class="card"><h2>Agent sessions</h2><div class="lanes" id="lanes"></div></div>
<div class="card"><h2>Trunk files</h2><div id="files"></div></div>
</section><aside>
<div class="card"><h2>Landed commits</h2><div id="commits"></div></div>
<div class="card"><h2>Live event feed</h2><div id="events"></div></div>
</aside></main>
<script>
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const api=(m,p,b)=>fetch('/api/'+p,{method:m,headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined}).then(r=>r.json());
const t=ts=>new Date(ts).toLocaleTimeString([], {hour12:false});
async function refresh(){
  const s=await api('GET','state');
  $('rev').textContent='trunk r'+s.rev;
  $('lanes').innerHTML=s.sessions.map(x=>'<div class="lane"><b>'+esc(x.agent)+'</b><small>'+esc(x.goal)+'</small><br><small>'+esc(Object.keys(x.edits).join(', ')||x.intent.join(', '))+'</small><br><span class="pill '+x.status+'">'+x.status.replace('_',' ')+(x.landedRev?' r'+x.landedRev:'')+'</span></div>').join('')||'<small>No sessions yet.</small>';
  $('files').innerHTML=Object.entries(s.files).map(([p,c])=>'<details><summary>'+esc(p)+'</summary><pre>'+esc(c)+'</pre></details>').join('');
  $('commits').innerHTML=s.commits.slice().reverse().map(c=>'<div class="ev"><b>r'+c.rev+'</b> '+esc(c.agent)+(c.merged?' <span class="t-overlap">merged</span>':'')+'<br><small>'+esc(c.message)+'</small></div>').join('');
  $('events').innerHTML=s.events.slice().reverse().map(e=>'<div class="ev t-'+e.type+'"><i>'+t(e.ts)+'</i>'+esc(e.message)+'</div>').join('');
}
async function step(st){
  if(st.op==='note'){$('note').textContent=st.text;return}
  const id=st.id,base='sessions/'+id+'/';
  if(st.op==='open')await api('POST','sessions',{id,agent:st.agent,goal:st.goal,intent:st.intent});
  if(st.op==='write')await api('POST',base+'file',{path:st.path,content:st.content});
  if(st.op==='submit')await api('POST',base+'submit',{message:st.message});
  if(st.op==='resolve')await api('POST',base+'resolve',{path:st.path,how:st.how});
  if(st.op==='review')await api('POST',base+'review',{reviewer:st.reviewer,approve:st.approve});
}
$('reset').onclick=async()=>{await api('POST','reset',{});refresh()};
$('run').onclick=async()=>{
  $('run').disabled=true;await api('POST','reset',{});await refresh();
  const {steps}=await api('GET','scenario');
  for(const st of steps){await step(st);await refresh();await new Promise(r=>setTimeout(r,st.op==='note'?1800:900))}
  $('run').disabled=false;
};
refresh();setInterval(refresh,1500);
</script></body></html>`;
