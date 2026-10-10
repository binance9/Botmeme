'use strict';
(function (root) {
  function openPositions(trades) {
    const seen = new Set();
    return trades.filter(t => {
      const key = JSON.stringify([t.network, t.tokenId]);
      if (t.side !== 'BUY' || t.status !== 'open' || seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  function markers(trades, market, candles, span) {
    if (!market || market.priceSource === 'REFERENCE_FEED' || !candles.length) return [];
    return trades.filter(t => t.network === market.network && t.tokenId === market.tokenId && ['BUY', 'SELL', 'REDUCE'].includes(t.side)).flatMap(t => {
      const at = Date.parse(t.updatedAt), value = t.side === 'BUY' ? t.entryPriceUsd : t.exitPriceUsd;
      if (!Number.isFinite(at) || !Number.isFinite(value) || value <= 0) return [];
      // Only a real candle covering the fill time may receive a marker; no fabricated bars.
      const candle = candles.find(c => at >= c.timestamp && at < c.timestamp + span);
      return candle ? [{ id: t.id, timestamp: candle.timestamp, value, at, side: t.side }] : [];
    });
  }
  function dateTime(at) {
    if (!at || !Number.isFinite(Date.parse(at))) return '—';
    const parts = new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Ho_Chi_Minh', hour:'2-digit', minute:'2-digit', second:'2-digit', day:'2-digit', month:'2-digit', hourCycle:'h23'}).formatToParts(new Date(at));
    const p = Object.fromEntries(parts.map(p => [p.type,p.value]));
    return `${p.hour}:${p.minute}:${p.second} ${p.day}/${p.month}`;
  }
  function duration(ms) {
    if (!Number.isFinite(ms)) return '—';
    const seconds = Math.floor(ms / 1000);
    return `${Math.floor(seconds/3600)}h ${Math.floor(seconds/60)%60}m ${seconds%60}s`;
  }
  function historyRows(trades) {
    return trades.filter(t => t.side !== 'BUY' || t.status !== 'open').slice().sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
  }
  function detailCells(t) {
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    const price = n => Number.isFinite(n) ? '$'+Number(n.toPrecision(7)) : '—';
    const pnl = Number.isFinite(t.pnlUsd) ? `${t.pnlUsd>0?'+':''}$${t.pnlUsd.toFixed(2)} / ${Number.isFinite(t.pnlPct)?t.pnlPct.toFixed(2)+'%':'—'}` : '—';
    const reason = t.status==='open' && t.soldPct>0 ? `${t.sellBadge} · Đã chốt ${t.bankedPnlUsd<0?'−':'+'}$${Math.abs(t.bankedPnlUsd).toFixed(2)} (${t.bankedPnlPct.toFixed(2)}%) · Còn ${t.remainingQuantity.toLocaleString('en-US',{maximumSignificantDigits:7})} token` : t.closeReasonCode ? `${t.closeReasonCode} · ${t.closeReason}` : t.closeReason;
    return [dateTime(t.enteredAt),dateTime(t.exitedAt),price(t.entryPriceUsd),price(t.exitPriceUsd),pnl,reason || (t.status==='open'?'Đang mở':t.status==='archived'?'Lưu trữ · chưa có bằng chứng đóng':'Chưa có bằng chứng lý do đóng'),duration(t.holdingMs)].map((v,i)=>i===4 ? `<td style="color:${t.pnlUsd<0?'#ef4444':'#22c55e'}">${esc(v)}${t.markStale?' <small>(giá cũ)</small>':t.mark==='entry'?' <small>(giá vào)</small>':''}</td>` : `<td>${esc(v)}</td>`).join('');
  }
  const api = { openPositions, markers, dateTime, duration, historyRows, detailCells };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MemeTradeView = api;
})(typeof window === 'object' ? window : globalThis);

/* Read-only projection of the server's authoritative event state. No generated data. */
'use strict';
if (typeof document !== 'undefined') (() => {
  const $ = selector => document.querySelector(selector);
  const names = ['JEV', 'CODEX 1', 'CODEX 2', 'CODEX 3'];
  const roles = ['Meme Hunter', 'Commander · Não chính', 'Quant Learner', 'Forensic Analyst'];
  const headlines = ['Đang quét token mới...', 'Điều phối hệ thống...', 'Phân tích dữ liệu giao dịch...', 'Kiểm định & điều tra...'];
  const descriptions = ['Quét — • DEX • X Trending', 'Quản lý chiến lược • Theo dõi lệnh', 'Học từ kết quả • Tối ưu chiến lược', 'Đối chiếu chiến lược • Điều tra lệnh'];
  const networkLabel = network => ({ SOLANA: 'Solana', ETHEREUM: 'Ethereum', BSC: 'BSC', ROBINHOOD: 'Robinhood' }[network] || network || '—');
  const colors = ['green', 'blue', 'purple', 'orange'];
  const symbols = ['◉', '◎', '◈', '⚙'];
  const ids = ['jev', 'codex-1', 'codex-2', 'codex-3'];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
  const coinName = symbol => {
    if (!symbol) return '—';
    if (/^0x[a-fA-F0-9]{8,}$/.test(symbol) || symbol.length > 24) return symbol.slice(0, 6) + '…' + symbol.slice(-4);
    return symbol;
  };
  const time = at => at ? new Date(at).toLocaleTimeString('vi-VN', { hour12:false }) : '—';
  const money = value => value.toLocaleString('en-US', { minimumFractionDigits:2, maximumFractionDigits:2 });
  const priceText = value => value == null ? '—' : Number(value.toPrecision(7)).toString();
  const signed = value => `${value > 0 ? '+' : value < 0 ? '-' : ''}$${money(Math.abs(value))}`;
  let snapshot = null, connected = false, interval = 60000, expanded = false;
  let kChart = null, chartKey = null, chartFirst = null, chartCount = 0, chartPrecision = null;
  const avatars = [260,585,902,1231].map(x => `<image href="reference.png" x="-${x}" y="-90" width="1536" height="1024"/>`);
  const solAvatar = '<svg viewBox="0 0 32 32" role="img" aria-label="Solana"><defs><linearGradient id="sol-gradient" x2="1" y2="1"><stop stop-color="#9945ff"/><stop offset="1" stop-color="#14f195"/></linearGradient></defs><path fill="url(#sol-gradient)" d="M8 6h20l-4 5H4zm-4 8h20l4 5H8zm4 8h20l-4 5H4z"/></svg>';
  let referenceCandles = new Map(), referenceFrame = null, referenceStatus = 'connecting', referenceLast = null;
  const chartFeed = window.MemeReferenceStream.create({
    onCandle(candle, frame) { if (REFERENCE_QUERY[interval] !== frame) return; referenceCandles.set(candle.timestamp, candle); while(referenceCandles.size>600)referenceCandles.delete(referenceCandles.keys().next().value); referenceLast=candle; renderChart(); },
    onStatus(status) { referenceStatus=status; }
  });
  $('#agents').innerHTML = names.map((name,i) => `<article class="agent-card ${colors[i]}"><div class="agent-head"><div class="avatar"><svg viewBox="0 0 60 60" aria-hidden="true">${avatars[i]}</svg></div><div class="agent-identity"><h2>${name}</h2><p>${roles[i]}</p></div><span class="running">WAITING</span></div><p class="agent-task">${headlines[i]}</p><p class="agent-description">${descriptions[i]}</p><div class="progress-row"><div class="progress-track" role="progressbar" aria-label="Tiến độ ${name}" aria-valuemin="0" aria-valuemax="100"><i style="width:0%"></i></div><span class="agent-percent">—</span></div><div class="agent-detail">${i === 0 ? 'Tìm thấy: — token<br>Tiềm năng: —' : i === 1 ? 'Lệnh đang xử lý: —<br>Chiến lược: —' : i === 2 ? 'Lượng phân tích: — trade<br>Tìm nguyên nhân thua lỗ' : 'Lệnh hôm nay: —<br>Thành công: — | Thất bại: —'}</div><p class="agent-updated">Cập nhật: <time>—</time></p></article>`).join('');

  window.addEventListener('pagehide', () => chartFeed.close(), { once: true });
  function renderAgents() {
    document.querySelectorAll('.agent-card').forEach((card,i) => {
      const agent = snapshot?.agents.find(a => a.id === ids[i]);
      card.querySelector('.agent-identity p').textContent = roles[i];
      const journal = (agent?.status || 'waiting').toUpperCase();
      const status = !connected && snapshot ? 'OFFLINE' : snapshot?.control?.running === false ? 'STOPPED' : agent?.work?.running > 0 ? 'RUNNING' : journal;
      const badge = { RUNNING: 'RUNNING', COMPLETED: 'XONG', WAITING: 'CHỜ', FAILED: 'LỖI', STOPPED: 'DỪNG', IDLE: 'CHỜ', OFFLINE: 'OFF' }[status] || status;
      card.querySelector('.running').textContent = badge;
      card.querySelector('.running').style.opacity = status === 'RUNNING' ? '1' : '.65';
      card.querySelector('.agent-task').textContent = status==='STOPPED' ? 'Đã dừng xử lý' : agent?.task ? activityLine({producer:['JEV','CODEX_1','CODEX_2','CODEX_3'][i],message:agent.task}) : 'Chờ công việc có dữ liệu';
      card.querySelector('.agent-task').title = agent?.task || headlines[i];
      card.querySelector('.agent-description').textContent = i === 0 ? `Quét ${networkLabel(snapshot?.network)} • DEX • X Trending` : descriptions[i];
      card.dataset.status = status;
      const idle = status !== 'RUNNING' && status !== 'STOPPED' && status !== 'OFFLINE';
      const percent = agent?.progress != null ? agent.progress : null;
      const age = agent?.updatedAt ? Math.max(0,Math.floor((Date.now()-Date.parse(agent.updatedAt))/1000)) : null;
      card.querySelector('.agent-percent').textContent = idle || percent == null ? age == null ? 'Chờ sự kiện' : `${age}s trước` : `${percent.toFixed(1)}%`;
      const track = card.querySelector('.progress-track');
      if (agent?.progress == null) track.removeAttribute('aria-valuenow'); else track.setAttribute('aria-valuenow', agent.progress);
      track.classList.toggle('heartbeat', idle && age != null || status === 'RUNNING' && percent == null);
      track.querySelector('i').style.width = `${idle || percent == null ? 100 : percent}%`;
      track.querySelector('i').style.opacity = status === 'STOPPED' || status === 'OFFLINE' ? '.25' : '1';
      if(idle || percent == null)track.removeAttribute('aria-valuenow');
      card.querySelector('time').textContent = time(agent?.updatedAt);
      const scan = snapshot?.scan;
      const summary = snapshot?.summary;
      const closed = (snapshot?.trades || []).filter(t => t.status !== 'open' && t.pnlUsd != null);
      const won = closed.filter(t => t.pnlUsd >= 0).length;
      const lost = closed.filter(t => t.pnlUsd < 0).length;
      const detail = [
        `Số lần quét: <b>${snapshot ? snapshot.scanRuns : '—'}</b><br>Tìm thấy: <b>${scan ? scan.found : '—'}</b> token · Tiềm năng: <b>${scan ? scan.candidates : '—'}</b><br>Nhiệm vụ: <b>${agent?.completed ?? '—'}</b>`,
        `Nhiệm vụ: <b>${agent?.completed ?? '—'}</b><br>Lệnh đang xử lý: <b>${summary ? summary.openPositions : '—'}</b>`,
        `Nhiệm vụ: <b>${agent?.completed ?? '—'}</b><br>Đánh giá hoàn tất: <b>${agent?.completed ?? '—'}</b>`,
        `Nhiệm vụ: <b>${agent?.completed ?? '—'}</b><br>Lệnh hôm nay: <b>${summary ? summary.totalTrades : '—'}</b> · Thắng: <b>${summary ? won : '—'}</b> / Thua: <b>${summary ? lost : '—'}</b>`
      ];
      card.querySelector('.agent-detail').innerHTML = (agent?.metric ? `${esc(agent.metric.label)}: <b>${agent.metric.done}</b>` : detail[i]) + (i===0?`<br>Token bắt được giờ qua: <b>${agent?.tokensThisHour ?? 0}</b>`:i===2?`<br>Lệnh đóng: <b>${agent?.closedTrades ?? 0}</b> · Học bằng mẫu giá`:i===3?`<br>RootCauseReport: <b>${agent?.reportsProcessed ?? 0}</b>`:'')+(agent?.work ? `<br>Đã xử lý: <b>${(agent.work.workMs/1000).toFixed(1)} giây</b><br>Receipt: ${agent.work.completed} · Lỗi: ${agent.work.failures}` : '');
      track.title = `${agent?.metric?.label || 'Tiến độ từ sự kiện'}${percent == null ? '' : ': '+percent.toFixed(1)+'%'} · ${idle ? 'Nhịp hoạt động gần nhất, không phải % hoàn thành' : status}`;
    });
  }
  const pendingExits = new Set(); const pendingEntries = new Set();
  const unsellable = new Set(); const unsellableEvidence = new Map();
  const manualControlsEnabled = () => snapshot?.control?.mode === 'live' || (snapshot?.control?.mode !== 'safe' && snapshot?.control?.paperExit);
  const compactUsd = value => Number.isFinite(value) ? value>0&&value<.01 ? '&lt;$0.01' : '$' + new Intl.NumberFormat('en-US', { notation:'compact', maximumFractionDigits:2 }).format(value) : '—';
  function tokenAge(t) {
    const age = t.tokenCreatedAt ? Date.now() - Date.parse(t.tokenCreatedAt) : t.poolAgeMs;
    if (!Number.isFinite(age) || age < 0) return '—';
    return age < 60000 ? Math.floor(age/1000)+'s' : age < 3600000 ? Math.floor(age/60000)+'m' : age < 86400000 ? Math.floor(age/3600000)+'h' : Math.floor(age/86400000)+'d';
  }
  function renderTrades() {
    const trades = snapshot?.trades || [], rows = window.MemeTradeView.openPositions(trades);
    $('#positions-count').textContent = rows.length;
    
    const html = rows.map(t => {
      const id = t.tradeId || t.id, busy = pendingExits.has(id), unavailable = !manualControlsEnabled(), name = coinName(t.symbol || t.tokenId);
      const icon = t.image ? `<img class="trade-token-icon" src="/api/asset-image?u=${encodeURIComponent(t.image)}" alt="${esc(t.name || name)}" title="${esc(t.name || name)}">` : `<span class="trade-monogram" title="${esc(t.name || name)}">${esc(name.slice(0,2))}</span>`;
      const stats = [t.marketCapUsd,t.athMarketCapUsd,t.liquidityUsd,t.volume24hUsd].map(v => `<td title="${Number.isFinite(v) ? esc('$'+money(v)) : 'Chưa có dữ liệu'}">${compactUsd(v)}</td>`).join('');
      return `<tr data-position="${esc(id)}"><td><button class="trade-token" data-chart-token="${esc(t.tokenId)}" data-network="${esc(t.network)}" title="${esc(t.tokenId)}">${icon}<span class="trade-identity"><strong>${esc(name)}</strong><span class="trade-subline"><span class="trade-age" title="Thời gian tạo pool (UTC+7)">${window.MemeTradeView.dateTime(t.tokenCreatedAt)} · ${tokenAge(t)}</span><small>${esc(networkLabel(t.network))}</small></span></span></button></td>${stats}${window.MemeTradeView.detailCells(t)}<td class="trade-actions"><button class="buy-position" data-buy-token="${esc(t.tokenId)}" data-network="${esc(t.network)}" aria-label="BUY ${esc(name)}" ${pendingEntries.has(t.tokenId)||unavailable?'disabled':''} title="Mua thêm vị thế (risk gate vẫn áp dụng)">${pendingEntries.has(t.tokenId)?'Đang mua…':'MUA'}</button><button class="sell-position" data-sell-id="${esc(id)}" aria-label="SELL 100% ${esc(name)}" ${busy||unavailable?'disabled':''} title="${unavailable?'Lệnh thủ công hiện chưa khả dụng':'Bán toàn bộ phần vị thế còn lại'}">${busy?'Đang bán…':'SELL'}</button></td></tr>`;
    }).join('') || '<tr><td colspan="13" class="table-empty">Không có vị thế đang mở</td></tr>';
    if ($('#trade-rows').innerHTML !== html) $('#trade-rows').innerHTML = html;
    const history = window.MemeTradeView.historyRows(trades);
    const historyHtml = history.map(t => {
      const name = coinName(t.symbol || t.tokenId);
      const icon = t.image ? `<img class="trade-token-icon" src="/api/asset-image?u=${encodeURIComponent(t.image)}" alt="${esc(t.name || name)}" title="${esc(t.name || name)}">` : `<span class="trade-monogram" title="${esc(t.name || name)}">${esc(name.slice(0,2))}</span>`;
      return `<tr><td><span class="trade-token">${icon}<span><strong>${esc(name)}</strong><br><small>Tạo pool: ${window.MemeTradeView.dateTime(t.tokenCreatedAt)} (UTC+7)</small></span></span></td><td>${esc(t.side)}</td>${window.MemeTradeView.detailCells(t)}</tr>`;
    }).join('') || '<tr><td colspan="9" class="table-empty">Chưa có lịch sử</td></tr>';
    const withdrawals = (snapshot?.withdrawals || []).map(e => `<tr><td colspan="9">${esc(e.message)} · ${time(e.occurredAt)}</td></tr>`).join('');
    if ($('#history-rows').innerHTML !== historyHtml + withdrawals) $('#history-rows').innerHTML = historyHtml + withdrawals;
  }
  function tradeTab(history) {
    $('#positions-view').hidden=history; $('#history-view').hidden=!history;
    $('#positions-tab').setAttribute('aria-selected',String(!history)); $('#history-tab').setAttribute('aria-selected',String(history));
  }
  $('#positions-tab').addEventListener('click',()=>tradeTab(false));
  $('#history-tab').addEventListener('click',()=>tradeTab(true));
  $('.trade-tabs').addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const history=event.key==='End'||event.key==='ArrowRight';tradeTab(history);$(history?'#history-tab':'#positions-tab').focus();}});
  async function sellPaper(tradeId, output=$('#trade-feedback')) {
    if(!manualControlsEnabled()){output.textContent='Lệnh thủ công hiện chưa khả dụng.';return;}
    if(pendingExits.has(tradeId))return;
    pendingExits.add(tradeId);renderTrades();renderDetail();output.textContent=unsellable.has(tradeId)?'Đang ghi sổ xoá bỏ vị thế…':'Đang bán 100% vị thế…';
    try {
      const body={tradeId,side:'SELL',percent:100,execute:true};
      if(unsellable.has(tradeId)){body.writeOff=true;body.evidence=unsellableEvidence.get(tradeId)||['dashboard: operator close-out'];}
      const response=await fetch('/api/orders/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const result=await response.json();
      if(result.snapshot && (!snapshot || result.snapshot.version>=snapshot.version)){snapshot=result.snapshot;render();}
      if(!response.ok)throw Error(result.error||result.reason||'Không thực thi được lệnh');
      if(result.status==='UNSELLABLE'){unsellable.add(tradeId);unsellableEvidence.set(tradeId,result.evidence||[]);output.textContent='Không thể bán on-chain: '+result.reason+' — Bấm SELL lần nữa để ghi sổ xoá bỏ vị thế này.';return;}
      if(result.status==='CLOSED_OUT'){unsellable.delete(tradeId);unsellableEvidence.delete(tradeId);output.textContent='Đã ghi sổ xoá bỏ · '+Number(result.quantity).toLocaleString('en-US',{maximumSignificantDigits:7})+' token · vốn '+Number(result.costBasis).toFixed(2)+' USD ghi nhận lỗ (không thể bán on-chain).';return;}
      output.textContent=result.status==='FILLED'?'Đã bán · '+Number(result.quantity).toLocaleString('en-US',{maximumSignificantDigits:7})+' token.':'Đã gửi · đang chờ biên nhận thực thi.';
    }catch(error){output.textContent='Chưa bán được: '+error.message;}
    finally{pendingExits.delete(tradeId);renderTrades();renderDetail();}
  }
  async function buyPaper(token, output=$('#trade-feedback')) {
    if (!manualControlsEnabled()) { output.textContent = 'Lệnh thủ công hiện chưa khả dụng.'; return; }
    if(!token||typeof token!=='string')return;
    if(pendingEntries.has(token))return;
    pendingEntries.add(token);renderTrades();renderDiscoveries();output.textContent='Đang mua vị thế…';
    try {
      const response=await fetch('/api/orders/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,side:'BUY',execute:true})});
      const result=await response.json();
      if(result.snapshot && (!snapshot || result.snapshot.version>=snapshot.version)){snapshot=result.snapshot;render();}
      if(!response.ok)throw Error(result.error||result.reason||'Không thực thi được lệnh');
      output.textContent=result.status==='FILLED'?'Đã mua · '+Number(result.quantity).toLocaleString('en-US',{maximumSignificantDigits:7})+' token.':result.reason||'Đã gửi · đang chờ biên nhận thực thi.';
    }catch(error){output.textContent='Chưa mua được: '+error.message;}
    finally{pendingEntries.delete(token);renderTrades();renderDiscoveries();}
  }
  $('#trade-rows').addEventListener('error',event=>{if(event.target.matches('img.trade-token-icon'))event.target.hidden=true;},true);
  $('#trade-rows').addEventListener('click',event=>{
    const sell=event.target.closest('[data-sell-id]');if(sell){sellPaper(sell.dataset.sellId);return;}
    const buy=event.target.closest('[data-buy-token]');if(buy){buyPaper(buy.dataset.buyToken);return;}
    const token=event.target.closest('[data-chart-token]');if(!token)return;
    const key=JSON.stringify([token.dataset.network,token.dataset.chartToken]);
    if(snapshot?.markets[key]){showDiscoveries(false);closeDetail();$('#chart-market').value=key;renderChart();}
  });
  function activityLine(event) {
    const message = String(event.message || '').replace(/\s+/g, ' ').trim();
    if (event.producer === 'SAFETY_GATE') return event.message.startsWith('Safety pass') ? 'Đạt cổng an toàn (on-chain ok)' : 'Bị cổng an toàn chặn: ' + message.replace(/^VETO:\s*/, '').slice(0, 80);
    if (event.producer === 'EXIT_MANAGER') return 'Bảo vệ vốn: ' + message.split(':')[0] + ' kích hoạt';
    if (event.producer === 'JEV' && /^Jev /.test(message)) return message.replace('Jev TRADE', 'Jev: đủ chuẩn vào lệnh').replace('Jev WATCH', 'Jev: theo dõi thêm').replace('Jev REJECT', 'Jev: loại ứng viên').replace('Jev NO_ACTION', 'Jev: chưa chấm được');
    const processed = message.match(/processed (\d+)/);
    if (event.producer === 'MARKET_DATA' || processed) return processed ? `Đang quét pool mới (${processed[1]})` : 'Đang quét pool mới';
    if (/rate limited/i.test(message)) return 'Sàn giới hạn tốc độ, đang chờ quét lại';
    if (/Research candidate/i.test(message)) return 'Thấy meme mới, chưa đặt lệnh';
    if (/No qualifying|watching/i.test(message)) return 'Chưa đủ chuẩn, đang theo dõi';
    if (/stale|future dated/i.test(message)) return 'Giá chưa mới, đang chờ';
    const compared = message.match(/Compared (\d+) candidates; journaled (\d+)/);
    if (compared) return `So ${compared[1]} ứng viên • ghi ${compared[2]} quyết định`;
    if (/Insufficient reliable/i.test(message)) return 'Chưa đủ lịch sử để học';
    if (/One task:/i.test(message)) return 'Đang điều tra lệnh';
    return message;
  }
  const displayText = value => String(value ?? '').replace(/\[?paper\]?|mô phỏng|USDC/gi, '').trim();
  function renderEvents() {
    // Legacy journals carry agentId/source instead of producer; map them so the activity feed stays alive.
    const producerOf = { 'codex-1': 'CODEX_1', 'codex-2': 'CODEX_2', 'codex-3': 'CODEX_3', scanner: 'MARKET_DATA', market: 'MARKET_DATA', 'paper-ledger': 'PAPER_EXECUTION', operator: 'RUNTIME' };
    const activities = (snapshot?.activities || []).map(e => ({ ...e, producer: typeof e.producer === 'string' && e.producer ? e.producer : producerOf[e.agentId || e.source] ?? 'RUNTIME', evidence: Array.isArray(e.evidence) ? e.evidence : [], correlationId: typeof e.correlationId === 'string' && e.correlationId ? e.correlationId : String(e.id ?? '') })).filter(e => typeof e.id === 'string' && e.id && typeof e.source === 'string' && e.source && ['JEV','CODEX_1','CODEX_2','CODEX_3','MARKET_DATA','STRATEGY_ENGINE','RISK_ENGINE','PAPER_EXECUTION','LIVE_EXECUTION','PERFORMANCE','RUNTIME','SAFETY_GATE','EXIT_MANAGER'].includes(e.producer));
    $('#activity-list').innerHTML = activities.length ? activities.slice(0,expanded ? 200 : 8).map(e => {
      const i = e.producer === 'MARKET_DATA' && e.agentId === 'jev' ? 0 : ['JEV','CODEX_1','CODEX_2','CODEX_3'].indexOf(e.producer), label = i < 0 ? ({PAPER_EXECUTION:'EXECUTION', LIVE_EXECUTION:'LIVE', RISK_ENGINE:'RISK', STRATEGY_ENGINE:'STRATEGY', MARKET_DATA:'MARKET', PERFORMANCE:'LEDGER', RUNTIME:'RUNTIME', SAFETY_GATE:'SAFETY', EXIT_MANAGER:'EXIT' }[e.producer]) : names[i];
      return `<div class="activity-row" data-event-id="${esc(e.id)}" data-producer="${esc(e.producer)}" data-source="${esc(e.source)}" title="${esc(displayText(e.message))}"><time>${time(e.occurredAt)}</time><span class="agent-tag ${colors[i < 0 ? 1 : i]}">${i < 0 ? '↔' : symbols[i]} ${label}</span><p>${esc(displayText(activityLine(e)))}${e.detail ? `<small style="color:var(--muted)"> · ${esc(displayText(e.detail))}</small>` : ''}</p></div>`;
    }).join('') : '<div class="activity-row"><p style="grid-column:1/-1">Chờ event từ nguồn dữ liệu</p></div>';
  }
  let discoveriesOpen=false;
  function renderDiscoveries(){
    const rows=(snapshot?.discoveries||[]).slice().sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
    $('#new-pools-count').textContent=String(rows.length);
    $('#new-pools-status').textContent=networkLabel(snapshot?.network)+' · '+(snapshot?.control?.running?'Đang quét':'Đã dừng')+' · '+(connected?'GeckoTerminal':'Mất kết nối');
    const amount=v=>Number.isFinite(v)?'$'+new Intl.NumberFormat('en-US',{maximumFractionDigits:2,notation:'compact'}).format(v):'—';
    const age=at=>{const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(at))/1000));return seconds<60?seconds+'s':seconds<3600?Math.floor(seconds/60)+'m':Math.floor(seconds/3600)+'h';};
    const html=rows.map(r=>{
      const logo=r.image?'<img alt="'+esc(r.name||r.symbol)+'" title="'+esc(r.name||r.symbol)+'" src="/api/asset-image?u='+encodeURIComponent(r.image)+'">':'<span class="meme-monogram" title="'+esc(r.name||r.symbol)+'">'+esc(r.symbol.slice(0,2))+'</span>';
      const stamp=new Date(r.createdAt).toLocaleString('vi-VN');
      const status=r.status.startsWith('ĐÃ BÁN')?r.status.split(' · ')[0]:r.status.startsWith('Bị chặn')?'Bị chặn':r.status.startsWith('Đã mua')?'Đã mua':r.status.startsWith('Đã bán')?'Đã bán':r.status.startsWith('JEV:')?r.status:'Đang theo dõi';
      return '<tr><td><button class="meme-open" data-meme="'+esc(r.token)+'" title="'+esc(r.token)+'"><span class="meme-logo">'+logo+'</span><span class="meme-label"><strong>'+esc(r.symbol)+'</strong><small>'+esc(r.token.slice(0,4)+'…'+r.token.slice(-4))+' · '+esc(networkLabel(r.network))+'</small></span></button></td><td title="Giờ tạo pool: '+esc(stamp)+'"><b class="meme-age">'+age(r.createdAt)+'</b><small>'+esc(new Date(r.createdAt).toLocaleTimeString('vi-VN'))+'</small></td><td title="'+esc(r.liquidityUsd==null?'Chưa xác minh':r.liquidityUsd+' USD')+'"><b>'+amount(r.liquidityUsd)+'</b><small>'+esc(r.stale?'Dữ liệu cũ':'Ghi nhận '+new Date(r.observedAt).toLocaleTimeString('vi-VN'))+'</small></td><td title="'+esc(r.marketCapUsd==null?'Vốn hóa chưa xác minh; FDV được ghi riêng':r.marketCapUsd+' USD')+'"><b>'+amount(r.marketCapUsd??r.fdvUsd)+'</b><small>'+esc(r.marketCapUsd==null?(r.fdvUsd==null?'Chưa xác minh':'FDV · chưa có MC'):'Vốn hóa')+'</small></td><td><span class="meme-check" title="'+esc(r.status)+'">'+esc(status)+'</span></td><td><button class="buy-position" data-buy-token="'+esc(r.token)+'" data-network="'+esc(r.network)+'" aria-label="BUY '+esc(r.symbol)+'" '+(pendingEntries.has(r.token)||!manualControlsEnabled()?'disabled':'')+' title="Mua vị thế cho token này (risk gate vẫn áp dụng)">'+(pendingEntries.has(r.token)?'Đang mua…':'MUA')+'</button></td></tr>';
    }).join('')||'<tr><td colspan="6">Đang chờ dữ liệu pool mới trên mạng này.</td></tr>';
    // Keep the current row targets and scroll position when the feed has not changed.
    if($('#new-pools-rows').innerHTML!==html)$('#new-pools-rows').innerHTML=html;
  }
  function showDiscoveries(open){
    if(open)closeDetail(); discoveriesOpen=open;$('.chart-panel').classList.toggle('show-new-pools',open);$('#new-pools-panel').hidden=!open;
    $('#chart-tab').setAttribute('aria-selected',String(!open));$('#new-pools-tab').setAttribute('aria-selected',String(open));
    renderDiscoveries();if(!open)kChart?.resize();
  }
  let selectedDiscovery=null;
  $('#new-pools-rows').addEventListener('click',async event=>{
    const buy=event.target.closest('[data-buy-token]');if(buy){buyPaper(buy.dataset.buyToken);return;}
    const button=event.target.closest('[data-meme]');if(!button)return;
    const row=snapshot.discoveries.find(r=>r.token===button.dataset.meme&&r.network===snapshot.network);if(!row)return;
    selectedDiscovery=row;showDiscoveries(false);$('.chart-panel').classList.add('token-detail');$('#token-detail-meta').hidden=false;$('#detail-history').hidden=false;$('#discovery-order-result').textContent='';renderDetail();renderChart();
    const chain={SOLANA:'sol',ETHEREUM:'eth',BSC:'bsc'}[row.network];
    $('#gmgn-chart').hidden=true;$('#gmgn-chart').removeAttribute('src');$('#price-chart').hidden=false;
    const link=$('#gmgn-token-link');link.hidden=!chain;
    if(chain)link.href='https://gmgn.ai/'+chain+'/token/'+encodeURIComponent(row.token);
    $('#chart-market').value=JSON.stringify([row.network,row.token]);renderChart();
    $('#discovery-order').hidden=false;$('#discovery-order-name').textContent=row.symbol+' · '+networkLabel(row.network);
    $('#discovery-order-result').textContent='Đang lấy giao dịch thật cho chart…';
    try{const response=await fetch('/api/chart/select',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({network:row.network,token:row.token})});const result=await response.json();if(selectedDiscovery!==row)return;$('#discovery-order-result').textContent=response.ok&&result.state==='observed'?'Đã nhận '+result.count+' giao dịch thị trường.':'Nguồn chart chưa sẵn sàng: '+(result.error||result.state||'Chưa có dữ liệu');}catch(error){if(selectedDiscovery===row)$('#discovery-order-result').textContent='Không lấy được dữ liệu chart.';}
  });
  $('#new-pools-rows').addEventListener('error',event=>{if(event.target.tagName==='IMG')event.target.hidden=true;},true);
  $('#discovery-order').addEventListener('click',event=>{
    if(!event.target.closest('[data-discovery-side="SELL"]')||!selectedDiscovery)return;
    const trade=window.MemeTradeView.openPositions(snapshot?.trades||[]).find(t=>t.network===selectedDiscovery.network&&t.tokenId===selectedDiscovery.token);
    if(trade)sellPaper(trade.tradeId||trade.id,$('#discovery-order-result'));
    else $('#discovery-order-result').textContent='Không có vị thế đang mở cho token này.';
  });
  $('#chart-tab').addEventListener('click',()=>showDiscoveries(false));$('#new-pools-tab').addEventListener('click',()=>showDiscoveries(true));
  function closeDetail(){
    
    $('.chart-panel').classList.remove('token-detail');$('#token-detail-meta').hidden=true;$('#detail-history').hidden=true;$('#discovery-order').hidden=true;selectedDiscovery=null;requestAnimationFrame(()=>kChart?.resize());
  }
  $('#detail-back').addEventListener('click',()=>{showDiscoveries(true);$('#new-pools-tab').focus();});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&selectedDiscovery)showDiscoveries(true);});
  function renderDetail(){
    if(!selectedDiscovery)return;
    const row=snapshot.discoveries?.find(r=>r.token===selectedDiscovery.token&&r.network===selectedDiscovery.network)||selectedDiscovery;
    $('#detail-ca').textContent=networkLabel(row.network)+' · '+row.token;
    const usd=n=>Number.isFinite(n)?'$'+new Intl.NumberFormat('en-US',{notation:'compact',maximumFractionDigits:2}).format(n):'—';
    $('#detail-stats').innerHTML=[['Vốn hóa',usd(row.marketCapUsd)],['FDV',usd(row.fdvUsd)],['Thanh khoản',usd(row.liquidityUsd)],['Pool tạo lúc',row.createdAt?new Date(row.createdAt).toLocaleString('vi-VN'):'—']].map(([label,value])=>'<div><small>'+esc(label)+'</small><b>'+esc(value)+'</b></div>').join('');
    const trades=(snapshot.trades||[]).filter(t=>t.network===row.network&&t.tokenId===row.token);
    const open=window.MemeTradeView.openPositions(trades)[0],sell=$('[data-discovery-side="SELL"]');
    sell.disabled=!manualControlsEnabled()||!open||pendingExits.has(open.tradeId||open.id);
    sell.textContent=!open?'Không có vị thế':pendingExits.has(open.tradeId||open.id)?'Đang bán…':'SELL 100%';
    $('#detail-history-rows').innerHTML=trades.length?trades.slice(0,20).map(t=>'<div class="detail-trade"><span>'+esc(time(t.updatedAt))+'</span><b class="'+(t.side==='BUY'?'positive':'negative')+'">'+esc(t.side)+'</b><span>'+esc(priceText(t.entryPriceUsd))+'</span><span>'+esc(t.status==='open'?'Đang mở':t.status==='archived'?'Lưu trữ':'Đã đóng')+'</span></div>').join(''):'<p>Chưa có giao dịch của bot cho token này.</p>';
  }
  function renderProtection() {
    const safety = snapshot?.safety, jev = snapshot?.jev;
    $('#safety-screened').textContent = safety ? String(safety.screened) : '—';
    $('#safety-approved').textContent = safety ? String(safety.approved) : '—';
    $('#safety-rejected').textContent = safety ? String(safety.rejected) : '—';
    $('#jev-rejected').textContent = jev ? String(jev.actions?.REJECT ?? 0) : '—';
    const rows = snapshot?.protection || [];
    const priceCell=value=>`<span title="${esc(priceText(value))}">${value!=null&&value>0&&value<.01 ? Number(value).toExponential(2) : value==null ? '—' : Number(value.toPrecision(5)).toString()}</span>`;
    $('#protection-rows').innerHTML = rows.length ? rows.map(p => {
      const price = p.priceUsd, stop = p.stopUsd, tp = p.takeProfitUsd;
      const danger = price != null && stop != null && price <= stop, target = price != null && tp != null && price >= tp;
      const control = p.sellBadge || (p.exits?.length ? 'EXIT ĐÃ KÍCH' : danger ? 'CHẠM CẮT LỖ' : target ? 'CHẠM CHỐT LỜI' : p.trailingArmed ? 'TRAILING BẬT' : 'AN TOÀN');
      const cls = p.exits?.length ? 'negative' : danger ? 'negative' : target ? 'positive' : 'positive';
      return `<tr><td title="${esc(p.tokenId)}"><span class="protection-token">${esc(coinName(p.symbol))}</span></td><td>${priceCell(p.entryPriceUsd)}</td><td>${priceCell(price)}</td><td class="negative">${priceCell(stop)}</td><td class="positive">${priceCell(tp)}</td><td><span class="pill ${p.exits?.length || danger ? 'sell' : 'open'} ${cls}">${esc(control)}</span></td></tr>`;
    }).join('') : '<tr><td colspan="6">Không có vị thế nào đang mở</td></tr>';
  }
  let overviewMode = 'today';
  document.querySelectorAll('[data-overview]').forEach(button => button.addEventListener('click', () => {
    overviewMode = button.dataset.overview;
    renderOverview();
  }));
  function renderOverview() {
    const s = snapshot?.summary ? { ...snapshot.summary, ...snapshot.overview?.[overviewMode] } : null;
    const price = snapshot?.paperWallet?.solPriceUsd;
    const sol = value => Number.isFinite(value) && price > 0 ? `${(value / price).toFixed(4)} SOL` : '—';
    $('#overview-title').textContent = overviewMode === 'month' ? 'TỔNG QUAN THÁNG NÀY' : 'TỔNG QUAN HÔM NAY';
    document.querySelectorAll('[data-overview]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.overview === overviewMode)));
    const pnl = s?.realizedPnlUsd != null && s?.unrealizedPnlUsd != null ? s.realizedPnlUsd + s.unrealizedPnlUsd : null;
    $('#pnl').textContent = pnl == null || !(price > 0) ? '—' : `${pnl >= 0 ? '+' : ''}${sol(pnl)}`;
    $('#pnl-usd').textContent = pnl == null ? '' : signed(pnl);
    $('#pnl').className = pnl != null && pnl < 0 ? 'negative' : 'positive';
    $('#total-trades').textContent = s?.totalTrades ?? '—';
    $('#win-rate').textContent = s?.winRate == null ? '—' : `${Math.round(s.winRate)}%`;
    $('#open-trades').textContent = s?.openPositions ?? '—';
    $('#capital-value').textContent = sol(s?.capitalUsedUsd);
    $('#capital-budget').textContent = sol(s?.paperCapitalUsd);
    const percent = s?.paperCapitalUsd ? 100 * s.capitalUsedUsd / s.paperCapitalUsd : null;
    $('#capital-percent').textContent = percent == null ? '—' : `${Math.round(percent)}%`;
    $('#capital-progress i').style.width = `${percent == null ? 0 : Math.min(100,percent)}%`;
    $('#capital-progress i').style.opacity = percent ? '1' : '0';
    if (percent == null) $('#capital-progress').removeAttribute('aria-valuenow'); else $('#capital-progress').setAttribute('aria-valuenow', Math.min(100,percent));
  }
  function chooseChart(view, choice='auto') {
    const markets=view?.markets||{},held=view?.activeToken;
    if(choice!=='auto'&&markets[choice])return {key:choice,fallback:false};
    const reference=Object.keys(markets).find(k=>markets[k]?.priceSource==='REFERENCE_FEED');
    const fill=view?.trades?.find(t=>t.id===markets[held]?.focusTradeId);
    const age=Date.parse(view?.asOf)-Date.parse(fill?.timestamp);
    const newBuy=Number.isFinite(age)&&age>=0&&age<300000;
    if(markets[held]?.quoteStale&&!newBuy&&reference)return {key:reference,fallback:true,held};
    return {key:held,fallback:false};
  }
  function renderChart() {
    let chooser=$('#chart-market');
    if(!chooser){
      const label=document.createElement('label');label.className='chart-market-label';label.textContent='Biểu đồ ';
      chooser=document.createElement('select');chooser.id='chart-market';chooser.setAttribute('aria-label','Chọn thị trường biểu đồ');label.append(chooser);$('#price-chart').before(label);
      chooser.addEventListener('change',()=>{$('#gmgn-chart').hidden=true;$('#gmgn-chart').removeAttribute('src');$('#price-chart').hidden=false;closeDetail();renderChart();});
    }
    const options=[['auto','Tự động'],...Object.entries(snapshot?.markets||{}).filter(([k,m])=>m?.priceSource==='REFERENCE_FEED'||m?.focusTradeId||(snapshot?.trades||[]).some(t=>t.network===m.network&&t.tokenId===m.tokenId)||m?.discovery||(snapshot?.discoveries||[]).some(r=>r.network===m.network&&r.token===m.tokenId)).map(([k,m])=>[k,m.priceSource==='REFERENCE_FEED'?'SOL/USDT · tham chiếu':coinName(m.symbol)+' · '+networkLabel(m.network)])];
    const optionKey=JSON.stringify(options);
    if(chooser.dataset.options!==optionKey){const previous=chooser.value;chooser.innerHTML=options.map(([key,label])=>`<option value="${esc(key)}">${esc(label)}</option>`).join('');if(options.some(([k])=>k===previous))chooser.value=previous;chooser.dataset.options=optionKey;}
    const selection=chooseChart(snapshot,chooser.value),selectedKey=selection.key;
    let market = snapshot?.markets[selectedKey];
    const isReference = market?.priceSource === 'REFERENCE_FEED';
    if(isReference){
      if(referenceFrame!==interval){referenceFrame=interval;referenceCandles.clear();referenceLast=null;chartFeed.select(interval);}
      if(referenceLast)market={...market,priceUsd:referenceLast.close};
    } else if(referenceFrame!==null){chartFeed.pause();referenceFrame=null;referenceLast=null;referenceCandles.clear();}
    const avatar = isReference ? solAvatar : market?.image ? `<img src="/api/asset-image?u=${encodeURIComponent(market.image)}" alt="${esc(market.symbol)}">` : `<span class="token-initial" title="Chưa có logo xác minh">${esc((market?.symbol || '?').slice(0,2))}</span>`;
    if($('#token-avatar').innerHTML!==avatar)$('#token-avatar').innerHTML=avatar;
    const shown = !market?.symbol ? '—' : coinName(market.symbol);
    $('#token-symbol').textContent = shown;
    const change = market?.priceUsd != null ? 100 * (market.priceUsd / market.firstPriceUsd - 1) : null;
    $('#price-change').textContent = change == null ? '—' : `${change > 0 ? '+' : ''}${change.toFixed(2)}%`;
    $('#price-change').className = change != null && change < 0 ? 'negative' : 'positive';
    const frame = frameLabel(interval);
    $('#price-chart').setAttribute('aria-label', `${market?.symbol || 'Chờ dữ liệu giá'}, ${frame}${market?.priceUsd != null ? `, giá ${priceText(market.priceUsd)} USD` : ''}${market?.historyStatus === 'INSUFFICIENT' ? ', INSUFFICIENT HISTORY' : ''}`);
    const live = isReference ? [...referenceCandles.values()].sort((a,b)=>a.timestamp-b.timestamp) : buildCandles(market, interval);
    const candles = mergeReferenceHistory(market, live).filter(validCandle);
    $('#price-chart').dataset.feed = isReference ? referenceStatus : 'observed';
    $('#price-chart').dataset.lastCandle = candles.at(-1)?.timestamp || '';
    let feedLabel=$('#chart-feed-label');if(!feedLabel){feedLabel=document.createElement('small');feedLabel.id='chart-feed-label';$('#price-chart').before(feedLabel);}
    feedLabel.textContent=isReference ? (referenceStatus==='live' ? 'SOL/USDT · Trực tiếp từ sàn' : 'SOL/USDT · Đang kết nối lại dữ liệu') : market?.quoteStale ? 'Giá cũ · '+networkLabel(market.network)+' · Chờ giao dịch/giá mới' : 'Dữ liệu thị trường đã quan sát';
    if(selection.fallback)feedLabel.textContent+=' · '+coinName(snapshot.markets[selection.held].symbol)+' chưa có giá mới; có thể chọn xem riêng ở trên';
    const key = `${selectedKey ?? ''}|${interval}`;
    if (!kChart) {
      klinecharts.registerOverlay({name:'botFill',totalStep:1,lock:true,needDefaultPointFigure:false,needDefaultXAxisFigure:false,needDefaultYAxisFigure:false,
        createPointFigures:({coordinates,overlay,bounding})=>{
          if(!coordinates.length)return [];
          const {x,y}=coordinates[0],buy=overlay.extendData.side==='BUY',color=buy?'#3fdb94':'#f6465d',offset=buy?17:-17,labelY=Math.max(12,Math.min(bounding.height-12,y+offset));
          return [{type:'circle',attrs:{x,y,r:3},styles:{color,style:'fill'},ignoreEvent:true},
            {type:'line',attrs:{coordinates:[{x,y},{x,y:labelY}]},styles:{color,size:1},ignoreEvent:true},
            {type:'text',attrs:{x,y:labelY,text:buy?'MUA':overlay.extendData.side==='REDUCE'?'BÁN ½':'BÁN',align:'center',baseline:'middle'},styles:{color,size:10,weight:'bold',backgroundColor:'transparent',borderColor:'transparent',borderSize:0,paddingLeft:0,paddingRight:0,paddingTop:0,paddingBottom:0},ignoreEvent:true}];
        }});
      kChart = klinecharts.init($('#price-chart'), { styles: chartStyles() });
      kChart.createIndicator({name:'VOL',calcParams:[]},false,{id:'volume_pane',height:65,minHeight:40,dragEnabled:false});
      // Vertical wheel belongs to the page/panel. Ctrl+wheel deliberately zooms the chart.
      $('#price-chart').addEventListener('wheel',event=>{
        if(event.ctrlKey||Math.abs(event.deltaX)>Math.abs(event.deltaY))return;
        event.preventDefault();event.stopImmediatePropagation();
        const unit=event.deltaMode===1?16:event.deltaMode===2?window.innerHeight:1;
        window.scrollBy({top:event.deltaY*unit,behavior:'instant'});
      },{capture:true,passive:false});
      $('#price-chart').title='Kéo để xem nến · Ctrl + cuộn để thu phóng';
    }
    if(key!==chartKey)kChart.setStyles(chartStyles());
    if(Number.isFinite(market?.priceUsd)&&market.priceUsd>0){const precision=Math.min(12,Math.max(2,2-Math.floor(Math.log10(market.priceUsd))));if(precision!==chartPrecision){kChart.setPriceVolumePrecision(precision,2);chartPrecision=precision;}}
    const extendsPrevious = key === chartKey && candles.length && candles[0].timestamp === chartFirst && candles.length >= chartCount;
    if (!candles.length || !extendsPrevious) {
      kChart.applyNewData(candles);
      chartKey = key; chartFirst = candles[0]?.timestamp ?? null; chartCount = candles.length;
    } else {
      for(const candle of candles.slice(Math.max(0, chartCount-1))) kChart.updateData(candle);
      chartFirst = candles[0].timestamp; chartCount = candles.length;
    }
    renderTradeMarkers(market,candles);
  }
  let markerKey=null;
  function renderTradeMarkers(market,candles){
    const markers=window.MemeTradeView.markers(snapshot?.trades||[],market,candles,interval);
    const key=JSON.stringify([chartKey,markers]);
    if(key===markerKey)return;markerKey=key;
    kChart.removeOverlay({groupId:'bot-fills'});
    if(markers.length)kChart.createOverlay(markers.map(m=>({name:'botFill',id:'bot-fill/'+m.id,groupId:'bot-fills',lock:true,points:[{timestamp:m.timestamp,value:m.value}],extendData:m})));
    $('#price-chart').dataset.botMarkers=String(markers.length);
  }
  // Khung thời gian 1s → 1W; nến tổng hợp từ quan sát thật của server, không bịa nến.
  const FRAMES = [[1000, 'nến 1 giây'], [60000, 'nến 1 phút'], [300000, 'nến 5 phút'], [900000, 'nến 15 phút'], [1800000, 'nến 30 phút'], [3600000, 'nến 1 giờ'], [14400000, 'nến 4 giờ'], [86400000, 'nến 1 ngày'], [604800000, 'nến 1 tuần']];
  const frameLabel = span => (FRAMES.find(([value]) => value === span) || [0, `nến ${span} ms`])[1];
  // Reference chart history: real exchange klines per interval, loaded once per switch.
  const REFERENCE_QUERY = { 1000: '1s', 60000: '1m', 300000: '5m', 900000: '15m', 1800000: '30m', 3600000: '1h', 14400000: '4h', 86400000: '1d', 604800000: '1w' };
  const refHistory = { interval: null, candles: [], requestId: 0 };
  function mergeReferenceHistory(market, live) {
    const isReference = market?.priceSource === 'REFERENCE_FEED';
    if (isReference && refHistory.interval !== interval) {
      refHistory.interval = interval; refHistory.candles = [];
      const requestId = ++refHistory.requestId;
      fetch(`/api/reference/klines?interval=${REFERENCE_QUERY[interval]}`).then(response => response.ok ? response.json() : Promise.reject(Error('HTTP_' + response.status))).then(body => {
        if (requestId === refHistory.requestId && Array.isArray(body?.candles)) {
          refHistory.candles = body.candles.map(c => ({ timestamp: c.at, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
          chartKey = null; renderChart();
        }
      }).catch(() => {});
    }
    if (!isReference || refHistory.interval !== interval || !refHistory.candles.length) return live;
    const merged = new Map(refHistory.candles.map(c => [c.timestamp, c]));
    for (const candle of live) merged.set(candle.timestamp, candle);
    return [...merged.values()].sort((a, b) => a.timestamp - b.timestamp);
  }
  function validCandle(c) { return Number.isSafeInteger(c?.timestamp) && [c.open,c.high,c.low,c.close].every(v=>Number.isFinite(v)&&v>0) && Number.isFinite(c.volume) && c.volume>=0 && c.high>=Math.max(c.open,c.close) && c.low<=Math.min(c.open,c.close); }
  function weekStart(at) { const day = Math.floor(at / 86400000), dow = (day + 4) % 7; return (day - ((dow + 6) % 7)) * 86400000; }
  function buildCandles(market, span) {
    if (!market) return [];
    const samples = span >= 60000 && market.candles?.length ? market.candles : (market.points || []).map(point => ({ at: point.at, open: point.priceUsd, high: point.priceUsd, low: point.priceUsd, close: point.priceUsd, volumeUsd: point.volumeUsd }));
    const buckets = new Map();
    for (const sample of samples) {
      if(!Number.isFinite(sample.at)||![sample.open,sample.high,sample.low,sample.close].every(v=>Number.isFinite(v)&&v>0))continue;
      const at = span === 604800000 ? weekStart(sample.at) : Math.floor(sample.at / span) * span;
      const volume = Number.isFinite(sample.volumeUsd) ? sample.volumeUsd : 0;
      const row = buckets.get(at);
      if (!row) buckets.set(at, { timestamp: at, open: sample.open, high: sample.high, low: sample.low, close: sample.close, volume });
      else { row.high = Math.max(row.high, sample.high); row.low = Math.min(row.low, sample.low); row.close = sample.close; row.volume += volume; }
    }
    return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp);
  }
  function chartStyles() {
    const read = name => (getComputedStyle(document.documentElement).getPropertyValue(name) || '').trim();
    const grid = read('--grid') || '#20262e', muted = read('--muted') || '#8798ab', line = read('--line') || '#20262e';
    const up='#3fdb94',down='#f6465d',neutral='#87909f',text=read('--text'),panel=read('--panel');
    const bars={upColor:up,downColor:down,noChangeColor:neutral,upBorderColor:up,downBorderColor:down,noChangeBorderColor:neutral,upWickColor:up,downWickColor:down,noChangeWickColor:neutral};
    const cross={show:true,line:{show:true,color:muted,size:1,style:'dashed'},text:{show:true,color:text,backgroundColor:panel,borderColor:line,size:10}};
    return {
      grid:{horizontal:{color:grid},vertical:{show:false}},
      candle:{type:'candle_solid',bar:bars,priceMark:{high:{color:muted},low:{color:muted},last:{show:true,upColor:up,downColor:down,noChangeColor:neutral,line:{show:true,style:'dashed'}}},
        tooltip:{showRule:'always',showType:'standard',text:{color:text,size:10,marginLeft:4,marginRight:6},custom:[{title:'',value:'{time}'},{title:'O ',value:'{open}'},{title:'H ',value:'{high}'},{title:'L ',value:'{low}'},{title:'C ',value:'{close}'},{title:'Vol ',value:'{volume}'}]}},
      indicator:{bars:[{...bars,style:'fill'}],tooltip:{showRule:'always',showName:true,showParams:false,text:{color:muted,size:10}}},
      xAxis:{axisLine:{color:line},tickText:{color:muted,size:10},tickLine:{show:false}},
      yAxis:{axisLine:{show:false},tickText:{color:muted,size:10},tickLine:{show:false}},
      separator:{color:line,fill:true,activeBackgroundColor:panel},crosshair:{show:true,horizontal:cross,vertical:cross}
    };
  }
  function connectionStatus() {
    $('#connection-status').textContent = connected ? 'State đã kết nối' : snapshot ? 'Mất kết nối state' : 'Chờ kết nối state';
    $('#stream-status').textContent = connected ? 'LIVE' : 'OFFLINE';
    document.querySelectorAll('.status-dot').forEach(dot=>{dot.style.opacity=connected?'1':'.3';});
    renderAgents();
  }
  function render() {
    if(selectedDiscovery&&selectedDiscovery.network!==snapshot.network){closeDetail();$('#discovery-order').hidden=true;$('#gmgn-chart').hidden=true;$('#gmgn-chart').removeAttribute('src');$('#price-chart').hidden=false;}
    document.documentElement.dataset.stateVersion = snapshot.version;
    const balance = $('#trading-sol');
    if (balance) {
      const sol = snapshot.control?.live?.balanceSol;
      balance.textContent = Number.isFinite(sol) ? `${sol.toFixed(4)} SOL` : '—';
    }
    renderAgents(); renderTrades(); renderOverview(); renderEvents(); renderChart(); renderProtection(); renderDiscoveries(); renderDetail();
  }
  const stream = new EventSource('/api/events');
  stream.addEventListener('state', event => {
    try {
      const next=JSON.parse(event.data);
      if (!Number.isSafeInteger(next.version) || !Array.isArray(next.agents) || !next.summary) throw new Error('Invalid state snapshot');
      // SSE order is authoritative; reconnects always bring a complete replacement.
      snapshot=next; connected=true; render(); connectionStatus();
    } catch(error) { connected=false; connectionStatus(); console.error('State projection failed:',error.message); }
  });
  stream.onerror=()=>{connected=false;connectionStatus();};
  function updateClock(){const now=new Date();$('#clock').textContent=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${time(now)}`;}
  function setTheme(dark){document.documentElement.dataset.theme=dark?'dark':'light';$('#theme-toggle').setAttribute('aria-checked',String(dark));$('#theme-toggle').setAttribute('aria-label',dark?'Bật Light mode':'Bật Dark mode');kChart?.setStyles(chartStyles());try{localStorage.setItem('meme-trader-theme',dark?'dark':'light');}catch{}}
  let savedTheme='dark';try{savedTheme=localStorage.getItem('meme-trader-theme')||'dark';}catch{}
  setTheme(savedTheme==='dark');$('#theme-toggle').addEventListener('click',()=>setTheme(document.documentElement.dataset.theme!=='dark'));
  document.querySelectorAll('[data-interval]').forEach(button=>button.addEventListener('click',()=>{interval=Number(button.dataset.interval);document.querySelectorAll('[data-interval]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button));});renderChart();}));
  $('#show-activity').addEventListener('click',()=>{expanded=!expanded;$('#show-activity').textContent=expanded?'Thu gọn':'Xem tất cả';$('#show-activity').setAttribute('aria-expanded',String(expanded));renderEvents();});
  document.querySelectorAll('nav a').forEach(link=>link.addEventListener('click',()=>{document.querySelectorAll('nav a').forEach(a=>{a.classList.toggle('active',a===link);a.removeAttribute('aria-current');});link.setAttribute('aria-current','location');if(link.hash==='#theme-toggle')$('#theme-toggle').focus();}));window.LongShortHub?.TradesMode.onNav(link.hash);
  renderAgents();renderTrades();renderEvents();renderChart();renderOverview();renderProtection();updateClock();connectionStatus();
  const chartObserver=new ResizeObserver(()=>kChart?.resize());chartObserver.observe($('#price-chart'));
  const clockTimer=setInterval(()=>{updateClock();renderAgents();},1000);
  window.addEventListener('pagehide',()=>{stream.close();clearInterval(clockTimer);chartObserver.disconnect();});
  window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
})();

