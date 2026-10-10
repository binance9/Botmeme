'use strict';
// Watcher: polls the dashboard state and prints every new fill + pipeline summary.
const http = require('node:http');
const seen = new Set();
function poll() {
  http.get('http://127.0.0.1:7883/api/state', res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const s = JSON.parse(d);
        const now = new Date().toISOString().slice(11, 19);
        const open = s.trades.filter(t => t.status === 'open');
        console.log(`[${now}] quét ${s.scan?.completed}/${s.scan?.total} | cand ${s.scan?.candidates} | duyệt ${s.safety?.approved} | mở ${open.length} | PnL ${Number(s.summary?.realizedPnlUsd).toFixed(4)}`);
        for (const t of s.trades) {
          const key = t.tokenId + t.side + t.status + (t.exitPriceUsd ?? '');
          if (seen.has(key)) continue;
          seen.add(key);
          console.log(`   >>> FILL ${t.symbol} ${t.side} ${t.status} vào ${t.entryPriceUsd} ra ${t.exitPriceUsd ?? '—'} PnL% ${t.pnlPct ?? '—'}`);
        }
      } catch (e) { console.log('[poll] parse lỗi:', e.message); }
    });
  }).on('error', () => console.log('[' + new Date().toISOString().slice(11, 19) + '] server không phản hồi'));
}
setInterval(poll, 60000);
poll();
