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
      const rt = normalizeTrend(t.ws_message_round_trip || {});
      const dl = normalizeTrend(t.ws_msg_deliver_time || t.ws_message_round_trip || {});
      const sa = normalizeTrend(t.ws_send_ack_time || {});
      const reconnectAttempt = c.ws_reconnect_attempt || 0;
      const reconnectSuccess = c.ws_reconnect_success || 0;
      const sendAskOk = sendAskOkOf(c);
      const msgDelivered = hasOwn(c, 'ws_msg_delivered') ? c.ws_msg_delivered || 0 : sendAskOk;
      const msgFailed = hasOwn(c, 'ws_msg_failed')
        ? c.ws_msg_failed || 0
        : c.ws_upsert_timeout || 0;
      return {
        runId: r.runId,
        timestamp: r.timestamp,
        mode: r.mode,
        userCount: r.config ? r.config.userCount : null,
        durationMs: r.durationMs || 0,
        checksPct: Math.round((r.checks ? r.checks.overallRate : 0) * 1000) / 10,
        connected: c.ws_connected || 0,
        connectError: c.ws_connect_error || 0,
        connectAttemptFail: c.ws_connect_attempt_fail || 0,
        messageSent: c.ws_message_sent || 0,
        sendAskOk,
        msgDelivered,
        msgFailed,
        deliverP95: dl.p95 ?? null,
        deliverP99: dl.p99 ?? null,
        sendAckOk: c.ws_send_ack_ok || 0,
        sendAckFail: c.ws_send_ack_fail || 0,
        sendAckTimeout: c.ws_send_ack_timeout || 0,
        closeUnexpected: c.ws_close_unexpected || 0,
        serverDisconnect: c.ws_server_disconnect || 0,
        reconnectAttempt,
        reconnectSuccess,
        reconnectExhausted: c.ws_reconnect_exhausted || 0,
        reconnectPct: reconnectAttempt
          ? Math.round((reconnectSuccess / reconnectAttempt) * 1000) / 10
          : 0,
        sendSkippedDisconnected: c.ws_send_skipped_disconnected || 0,
        sendAckP95: sa.p95 ?? null,
        roundTripP95: rt.p95 ?? null,
        roundTripP99: rt.p99 ?? null,
        roundTripMax: rt.max ?? null,
      };
    })
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

function hasOwn(o, k) {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function sendAskOkOf(c) {
  if (hasOwn(c, 'ws_send_ask_ok')) return c.ws_send_ask_ok || 0;
  if (hasOwn(c, 'ws_send_success')) return c.ws_send_success || 0;
  if (hasOwn(c, 'ws_upsert_timeout')) {
    return Math.max(0, (c.ws_message_sent || 0) - (c.ws_upsert_timeout || 0));
  }
  return 0;
}

function normalizeTrend(t) {
  if (!t || typeof t !== 'object') return {};
  const out = { ...t };
  const keys = ['avg', 'min', 'med', 'p95', 'p99', 'max'];
  const hasCount = Object.prototype.hasOwnProperty.call(out, 'count');
  // Treat a missing stat (undefined) the same as 0 so older run files that
  // predate the `min` field still normalize to "no samples".
  const allZero = keys.every((k) => out[k] == null || out[k] === 0);
  if ((hasCount && out.count === 0) || (!hasCount && allZero)) {
    out.count = 0;
    for (const k of keys) out[k] = null;
  }
  return out;
}

function normalizeRun(r) {
  if (!r) return null;
  const trends = r.trends || {};
  const counters = r.counters || {};
  return {
    ...r,
    counters: {
      ...counters,
      ws_send_ask_ok: sendAskOkOf(counters),
    },
    trends: {
      ...trends,
      ws_connect_time: normalizeTrend(trends.ws_connect_time || {}),
      ws_join_time: normalizeTrend(trends.ws_join_time || {}),
      ws_send_ack_time: normalizeTrend(trends.ws_send_ack_time || {}),
      ws_message_round_trip: normalizeTrend(trends.ws_message_round_trip || {}),
      ws_msg_deliver_time: normalizeTrend(
        trends.ws_msg_deliver_time || trends.ws_message_round_trip || {},
      ),
    },
  };
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]),
  );
}

function renderHtml(runs) {
  const history = buildHistory(runs);
  const latestFull = normalizeRun(pickLatestFull(runs, history));
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
function hasOwn(o,k){return Object.prototype.hasOwnProperty.call(o,k);}
function sendAskOkOf(c){
  if(hasOwn(c,'ws_send_ask_ok')) return c.ws_send_ask_ok||0;
  if(hasOwn(c,'ws_send_success')) return c.ws_send_success||0;
  if(hasOwn(c,'ws_upsert_timeout')) return Math.max(0,(c.ws_message_sent||0)-(c.ws_upsert_timeout||0));
  return 0;
}

function card(k,v,c){return '<div class="card"><div class="k">'+k+'</div><div class="v '+(c||'')+'">'+v+'</div></div>';}

function renderLatest(r){
  if(!r) return '<div class="empty">Chưa có dữ liệu. Chạy một test rồi mở lại.</div>';
  const c=r.counters,t=r.trends,cfg=r.config||{};
  const rt=t.ws_message_round_trip||{},sa=t.ws_send_ack_time||{},ct=t.ws_connect_time||{};
  const dl=t.ws_msg_deliver_time||rt, jt=t.ws_join_time||{};
  const ackPct=c.ws_message_sent?(c.ws_send_ack_ok/c.ws_message_sent*100):0;
  const delivered=hasOwn(c,'ws_msg_delivered')?(c.ws_msg_delivered||0):sendAskOkOf(c);
  const failed=hasOwn(c,'ws_msg_failed')?(c.ws_msg_failed||0):(c.ws_upsert_timeout||0);
  const deliveredPct=c.ws_message_sent?(delivered/c.ws_message_sent*100):0;
  const reconnPct=c.ws_reconnect_attempt?(c.ws_reconnect_success/c.ws_reconnect_attempt*100):0;
  const checksPct=(r.checks?r.checks.overallRate:0)*100;
  let h='';
  h+='<h2>Run mới nhất — <span class="pill">'+r.mode+'</span> '+new Date(r.timestamp).toLocaleString()+'</h2>';
  h+='<div class="cards">';
  h+=card('Users / VUs', cfg.userCount!=null?cfg.userCount:'-');
  h+=card('Connected', c.ws_connected, cls(c.ws_connected,(cfg.userCount||1)*0.9,(cfg.userCount||1)*0.5));
  h+=card('Connect errors', c.ws_connect_error, c.ws_connect_error===0?'ok':'bad');
  h+=card('Attempt fail', c.ws_connect_attempt_fail||0, (c.ws_connect_attempt_fail||0)===0?'ok':'warn');
  h+=card('Checks pass', checksPct.toFixed(1)+'%', cls(checksPct,90,60));
  h+='</div><div class="cards" style="margin-top:12px">';
  h+=card('Reconnect rate', c.ws_reconnect_attempt?reconnPct.toFixed(1)+'%':'-', c.ws_reconnect_attempt?cls(reconnPct,90,60):'');
  h+=card('Reconnects', (c.ws_reconnect_success||0)+' / '+(c.ws_reconnect_attempt||0));
  h+=card('Unexpected close', c.ws_close_unexpected||0, (c.ws_close_unexpected||0)===0?'ok':'bad');
  h+=card('Server disconnect', c.ws_server_disconnect||0, (c.ws_server_disconnect||0)===0?'ok':'bad');
  h+='</div><div class="cards" style="margin-top:12px">';
  h+=card('Tin đã gửi', c.ws_message_sent);
  h+=card('✅ Gửi thành công', delivered+' ('+pct(delivered,c.ws_message_sent)+')', cls(deliveredPct,90,50));
  h+=card('❌ Thất bại (>window)', failed+' ('+pct(failed,c.ws_message_sent)+')', failed===0?'ok':(deliveredPct>=50?'warn':'bad'));
  h+=card('Skipped (socket đóng)', c.ws_send_skipped_disconnected||0, (c.ws_send_skipped_disconnected||0)===0?'ok':'warn');
  if(cfg.requestAck) h+=card('Gateway ack ok', c.ws_send_ack_ok+' ('+pct(c.ws_send_ack_ok,c.ws_message_sent)+')', cls(ackPct,90,50));
  h+=card('Exceptions', c.ws_exception, c.ws_exception===0?'ok':'bad');
  h+='</div>';
  // Full latency table — avg / min / med / p95 / p99 / max for every stage.
  h+='<h3 style="margin:18px 0 6px">Độ trễ đầy đủ (ms)</h3>';
  h+='<table><thead><tr><th>Chặng</th><th>n</th><th>avg</th><th>min</th><th>med</th><th>p95</th><th>p99</th><th>max</th></tr></thead><tbody>';
  const latRow=(name,tr)=>'<tr><td>'+name+'</td><td>'+(tr.count||0)+'</td><td>'+fmtMs(tr.avg)+'</td><td>'+fmtMs(tr.min)+'</td><td>'+fmtMs(tr.med)+'</td><td>'+fmtMs(tr.p95)+'</td><td>'+fmtMs(tr.p99)+'</td><td>'+fmtMs(tr.max)+'</td></tr>';
  h+=latRow('Connect', ct);
  h+=latRow('Join', jt);
  h+=latRow('Giao tin (upsert echo)', dl);
  if(cfg.requestAck) h+=latRow('Gateway ack', sa);
  h+='</tbody></table>';
  return h;
}

function renderTable(hist){
  if(!hist.length) return '';
  let h='<h2>Lịch sử các lần chạy</h2><table><thead><tr>'+
    '<th>Thời gian</th><th>Mode</th><th>VUs</th><th>Connected</th><th>Conn.err</th><th>Attempt fail</th>'+
    '<th>Reconn.</th><th>Unexp.close</th><th>Tin gửi</th><th>✅ Thành công</th><th>❌ Thất bại</th><th>Skip</th><th>Giao tin p95</th><th>Giao tin p99</th><th>Checks</th></tr></thead><tbody>';
  for(const r of hist){
    const dlv=r.msgDelivered!=null?r.msgDelivered:r.sendAskOk;
    const fail=r.msgFailed!=null?r.msgFailed:'-';
    const dPct=r.messageSent?((dlv/r.messageSent)*100).toFixed(1)+'%':'-';
    h+='<tr><td>'+new Date(r.timestamp).toLocaleString()+'</td><td>'+r.mode+'</td><td>'+r.userCount+
      '</td><td>'+r.connected+'</td><td>'+r.connectError+'</td><td>'+r.connectAttemptFail+
      '</td><td>'+r.reconnectSuccess+'/'+r.reconnectAttempt+
      '</td><td>'+r.closeUnexpected+'</td><td>'+r.messageSent+'</td><td>'+dlv+' ('+dPct+')</td><td>'+fail+'</td><td>'+r.sendSkippedDisconnected+'</td><td>'+fmtMs(r.deliverP95!=null?r.deliverP95:r.roundTripP95)+
      '</td><td>'+fmtMs(r.deliverP99!=null?r.deliverP99:r.roundTripP99)+'</td><td>'+r.checksPct+'%</td></tr>';
  }
  return h+'</tbody></table>';
}

// Hand-drawn SVG line chart (oldest→newest left→right).
function lineChart(title, series){
  const data=HISTORY.slice().reverse();
  if(data.length<1) return '';
  const W=1040,H=180,pad=34;
  let max=1;
  for(const s of series) for(const r of data){const v=s.get(r);if(v!=null&&v>max)max=v;}
  function x(i){return pad+(data.length<=1?0:(i*(W-2*pad)/(data.length-1)));}
  function y(v){return H-pad-(v/max)*(H-2*pad);}
  let svg='<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">';
  svg+='<line x1="'+pad+'" y1="'+(H-pad)+'" x2="'+(W-pad)+'" y2="'+(H-pad)+'" stroke="#2a2e3a"/>';
  svg+='<text x="2" y="14" fill="#8b90a0" font-size="11">'+Math.round(max)+'</text>';
  for(const s of series){
    let d='';
    data.forEach((r,i)=>{const v=s.get(r);if(v==null)return;d+=(d?'L':'M')+x(i).toFixed(1)+' '+y(v).toFixed(1)+' ';});
    if(!d) continue;
    svg+='<path d="'+d+'" fill="none" stroke="'+s.color+'" stroke-width="2"/>';
    data.forEach((r,i)=>{const v=s.get(r);if(v==null)return;svg+='<circle cx="'+x(i).toFixed(1)+'" cy="'+y(v).toFixed(1)+'" r="2.5" fill="'+s.color+'"/>';});
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
    h+=lineChart('Độ trễ giao tin p95 / p99 (ms) — thời gian tới khi tin SENT',[
      {label:'giao tin p95',color:'#58a6ff',get:r=>r.deliverP95!=null?r.deliverP95:r.roundTripP95},
      {label:'giao tin p99',color:'#bc8cff',get:r=>r.deliverP99!=null?r.deliverP99:r.roundTripP99},
    ]);
    h+=lineChart('Lỗi (count)',[
      {label:'connect_error',color:'#f85149',get:r=>r.connectError},
      {label:'connect_attempt_fail',color:'#ff7b72',get:r=>r.connectAttemptFail},
      {label:'tin thất bại',color:'#d29922',get:r=>r.msgFailed!=null?r.msgFailed:0},
    ]);
    h+=lineChart('Reconnect recovery (%)',[
      {label:'reconnect success %',color:'#3fb950',get:r=>r.reconnectPct||0},
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
