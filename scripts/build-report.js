'use strict';

// Aggregate k6 per-run JSON (k6/reports/run-*.json, written by loadtest.js
// handleSummary) into:
//   - k6/reports/history.json   compact index of every run (newest first)
//   - k6/reports/index.html     SELF-CONTAINED report (data inlined, no server,
//                               no CDN, no fetch) — double-click to view.
//
// Pure functions (buildHistory/renderHtml) are unit-tested in
// build-report.test.js; main() does the file IO.

const fs = require('fs');
const path = require('path');

const REPORTS_DIR = path.resolve(__dirname, '..', 'k6', 'reports');

function loadRuns(dir) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const runs = [];
  for (const f of files) {
    if (!/^run-.*\.json$/.test(f)) continue;
    try {
      runs.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    } catch (err) {
      console.warn(`[build-report] skip ${f}: ${err.message}`);
    }
  }
  return runs;
}

// Compact, chart-friendly summary per run, sorted newest-first.
function buildHistory(runs) {
  return runs
    .map((r) => {
      const c = r.counters || {};
      const t = r.trends || {};
      const rt = t.ws_message_round_trip || {};
      const sa = t.ws_send_ack_time || {};
      return {
        runId: r.runId,
        timestamp: r.timestamp,
        mode: r.mode,
        userCount: r.config ? r.config.userCount : null,
        durationMs: r.durationMs || 0,
        checksPct: Math.round((r.checks ? r.checks.overallRate : 0) * 1000) / 10,
        connected: c.ws_connected || 0,
        connectError: c.ws_connect_error || 0,
        messageSent: c.ws_message_sent || 0,
        sendAckOk: c.ws_send_ack_ok || 0,
        sendAckFail: c.ws_send_ack_fail || 0,
        sendAckTimeout: c.ws_send_ack_timeout || 0,
        sendAckP95: sa.p95 || 0,
        roundTripP95: rt.p95 || 0,
        roundTripP99: rt.p99 || 0,
        roundTripMax: rt.max || 0,
      };
    })
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]),
  );
}

function renderHtml(runs) {
  const history = buildHistory(runs);
  const latestFull = pickLatestFull(runs, history);
  // Inline data — page works fully offline from file://.
  const dataScript = `<script>const HISTORY=${JSON.stringify(history)};const LATEST=${JSON.stringify(
    latestFull,
  )};</script>`;
  return PAGE(dataScript);
}

function pickLatestFull(runs, history) {
  if (!history.length) return null;
  const id = history[0].runId;
  return runs.find((r) => r.runId === id) || null;
}

// The whole page. CSS + JS inline. Charts are hand-drawn SVG (no libraries).
function PAGE(dataScript) {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>appchat — k6 load test report</title>
<style>
  :root{--bg:#0f1117;--card:#1a1d27;--line:#2a2e3a;--fg:#e6e8ee;--mut:#8b90a0;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--accent:#58a6ff}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
  header{padding:20px 24px;border-bottom:1px solid var(--line)}
  h1{margin:0;font-size:18px}
  .sub{color:var(--mut);font-size:12px;margin-top:4px}
  main{padding:24px;max-width:1100px;margin:0 auto}
  h2{font-size:14px;text-transform:uppercase;letter-spacing:.5px;color:var(--mut);margin:28px 0 12px}
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
  .card .k{color:var(--mut);font-size:12px}
  .card .v{font-size:22px;font-weight:600;margin-top:4px}
  .v.ok{color:var(--ok)}.v.bad{color:var(--bad)}.v.warn{color:var(--warn)}
  table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
  th,td{text-align:right;padding:8px 10px;border-bottom:1px solid var(--line)}
  th:first-child,td:first-child{text-align:left}
  th{color:var(--mut);font-weight:500}
  tr:hover td{background:#20242f}
  .chart{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-top:12px}
  .chart h3{margin:0 0 8px;font-size:13px;color:var(--mut);font-weight:500}
  .pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;border:1px solid var(--line)}
  .empty{color:var(--mut);padding:40px;text-align:center}
  svg{display:block;width:100%;height:180px}
  .lg{font-size:11px;color:var(--mut);margin-top:6px}
  .dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px;vertical-align:middle}
</style>
</head>
<body>
<header>
  <h1>appchat — k6 load test report</h1>
  <div class="sub" id="sub"></div>
</header>
<main id="app"></main>
${dataScript}
<script>
function fmtMs(n){if(n==null)return '-';return n>=1000?(n/1000).toFixed(2)+'s':Math.round(n)+'ms';}
function pct(n,d){return d?((n/d)*100).toFixed(1)+'%':'-';}
function cls(v,good,warn){return v>=good?'ok':v>=warn?'warn':'bad';}
function el(html){const t=document.createElement('template');t.innerHTML=html.trim();return t.content.firstChild;}

function card(k,v,c){return '<div class="card"><div class="k">'+k+'</div><div class="v '+(c||'')+'">'+v+'</div></div>';}

function renderLatest(r){
  if(!r) return '<div class="empty">Chưa có dữ liệu. Chạy một test rồi mở lại.</div>';
  const c=r.counters,t=r.trends,cfg=r.config||{};
  const rt=t.ws_message_round_trip||{},sa=t.ws_send_ack_time||{},ct=t.ws_connect_time||{};
  const ackPct=c.ws_message_sent?(c.ws_send_ack_ok/c.ws_message_sent*100):0;
  const checksPct=(r.checks?r.checks.overallRate:0)*100;
  let h='';
  h+='<h2>Run mới nhất — <span class="pill">'+r.mode+'</span> '+new Date(r.timestamp).toLocaleString()+'</h2>';
  h+='<div class="cards">';
  h+=card('Users / VUs', cfg.userCount!=null?cfg.userCount:'-');
  h+=card('Connected', c.ws_connected, cls(c.ws_connected,(cfg.userCount||1)*0.9,(cfg.userCount||1)*0.5));
  h+=card('Connect errors', c.ws_connect_error, c.ws_connect_error===0?'ok':'bad');
  h+=card('Checks pass', checksPct.toFixed(1)+'%', cls(checksPct,90,60));
  h+='</div><div class="cards" style="margin-top:12px">';
  h+=card('Messages sent', c.ws_message_sent);
  h+=card('Send ack ok', c.ws_send_ack_ok+' ('+pct(c.ws_send_ack_ok,c.ws_message_sent)+')', cls(ackPct,90,50));
  h+=card('Send ack timeout', c.ws_send_ack_timeout, c.ws_send_ack_timeout===0?'ok':'bad');
  h+=card('Exceptions', c.ws_exception, c.ws_exception===0?'ok':'bad');
  h+='</div><div class="cards" style="margin-top:12px">';
  h+=card('Connect p95', fmtMs(ct.p95));
  h+=card('Join p95', fmtMs((t.ws_join_time||{}).p95));
  h+=card('Send-ack p95 / p99', fmtMs(sa.p95)+' / '+fmtMs(sa.p99));
  h+=card('Round-trip p95 / p99', fmtMs(rt.p95)+' / '+fmtMs(rt.p99));
  h+='</div>';
  return h;
}

function renderTable(hist){
  if(!hist.length) return '';
  let h='<h2>Lịch sử các lần chạy</h2><table><thead><tr>'+
    '<th>Thời gian</th><th>Mode</th><th>VUs</th><th>Connected</th><th>Conn.err</th>'+
    '<th>Sent</th><th>Ack ok</th><th>Ack timeout</th><th>RT p95</th><th>RT p99</th><th>Checks</th></tr></thead><tbody>';
  for(const r of hist){
    h+='<tr><td>'+new Date(r.timestamp).toLocaleString()+'</td><td>'+r.mode+'</td><td>'+r.userCount+
      '</td><td>'+r.connected+'</td><td>'+r.connectError+'</td><td>'+r.messageSent+
      '</td><td>'+r.sendAckOk+'</td><td>'+r.sendAckTimeout+'</td><td>'+fmtMs(r.roundTripP95)+
      '</td><td>'+fmtMs(r.roundTripP99)+'</td><td>'+r.checksPct+'%</td></tr>';
  }
  return h+'</tbody></table>';
}

// Hand-drawn SVG line chart (oldest→newest left→right).
function lineChart(title, series){
  const data=HISTORY.slice().reverse();
  if(data.length<1) return '';
  const W=1040,H=180,pad=34;
  let max=1;
  for(const s of series) for(const r of data){const v=s.get(r);if(v>max)max=v;}
  function x(i){return pad+(data.length<=1?0:(i*(W-2*pad)/(data.length-1)));}
  function y(v){return H-pad-(v/max)*(H-2*pad);}
  let svg='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">';
  svg+='<line x1="'+pad+'" y1="'+(H-pad)+'" x2="'+(W-pad)+'" y2="'+(H-pad)+'" stroke="#2a2e3a"/>';
  svg+='<text x="2" y="14" fill="#8b90a0" font-size="11">'+Math.round(max)+'</text>';
  for(const s of series){
    let d='';
    data.forEach((r,i)=>{d+=(i?'L':'M')+x(i).toFixed(1)+' '+y(s.get(r)).toFixed(1)+' ';});
    svg+='<path d="'+d+'" fill="none" stroke="'+s.color+'" stroke-width="2"/>';
    data.forEach((r,i)=>{svg+='<circle cx="'+x(i).toFixed(1)+'" cy="'+y(s.get(r)).toFixed(1)+'" r="2.5" fill="'+s.color+'"/>';});
  }
  svg+='</svg>';
  let lg='<div class="lg">';
  for(const s of series) lg+='<span class="dot" style="background:'+s.color+'"></span>'+s.label+' &nbsp;';
  lg+='</div>';
  return '<div class="chart"><h3>'+title+'</h3>'+svg+lg+'</div>';
}

function render(){
  document.getElementById('sub').textContent=HISTORY.length+' run(s) recorded · generated '+new Date().toLocaleString();
  let h=renderLatest(LATEST);
  if(HISTORY.length){
    h+='<h2>Xu hướng qua các lần chạy</h2>';
    h+=lineChart('Round-trip latency p95 (ms)',[
      {label:'round-trip p95',color:'#58a6ff',get:r=>r.roundTripP95},
      {label:'send-ack p95',color:'#3fb950',get:r=>r.sendAckP95},
    ]);
    h+=lineChart('Lỗi & timeout (count)',[
      {label:'connect_error',color:'#f85149',get:r=>r.connectError},
      {label:'send_ack_timeout',color:'#d29922',get:r=>r.sendAckTimeout},
    ]);
    h+=renderTable(HISTORY);
  }
  document.getElementById('app').innerHTML=h;
}
render();
</script>
</body>
</html>`;
}

function main() {
  const runs = loadRuns(REPORTS_DIR);
  const history = buildHistory(runs);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(REPORTS_DIR, 'history.json'),
    JSON.stringify(history, null, 2),
    'utf8',
  );
  fs.writeFileSync(path.join(REPORTS_DIR, 'index.html'), renderHtml(runs), 'utf8');
  console.log(
    `[build-report] ${runs.length} run(s) → ${path.join(REPORTS_DIR, 'index.html')}`,
  );
}

module.exports = { loadRuns, buildHistory, renderHtml };

if (require.main === module) main();
