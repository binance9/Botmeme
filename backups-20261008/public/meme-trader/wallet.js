(() => {
  'use strict';
  const el = id => document.getElementById(id), root = el('wallet-control');
  if (!root) return;
  let state = null, busy = false, withdrawing = false, destinationNetwork = null;
  const message = text => { el('wallet-message').textContent = text; };
  async function api(url, data) {
    const response = await fetch(url, { method: data === undefined ? 'GET' : 'POST', headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data), credentials: 'same-origin', cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw Error(body.error || 'Không thể hoàn tất yêu cầu.');
    return body;
  }
  const dialog = document.createElement('dialog'); dialog.className = 'live-confirm';
  dialog.innerHTML = '<form method="dialog"><strong>Bật giao dịch tiền thật</strong><p id="live-confirm-detail"></p><label>Nhập LIVE để xác nhận<input name="confirm" autocomplete="off" required pattern="LIVE" placeholder="LIVE"></label><div><button value="cancel" formnovalidate>Hủy</button><button value="arm">Bật LIVE</button></div></form>';
  document.body.append(dialog);
  dialog.addEventListener('close', () => { if (dialog.returnValue === 'arm' && dialog.querySelector('input').value === 'LIVE') action(() => api('/api/control', { action: 'LIVE', confirm: 'LIVE_REAL_MONEY' })); badge.focus(); });
  const tpLabel=document.createElement('label');tpLabel.className='take-profit-control';tpLabel.textContent='Chốt hết ';
  const tp=document.createElement('select');tp.setAttribute('aria-label','Mốc chốt lời');tp.innerHTML='<option value="2">x2</option><option value="3">x3</option><option value="5">x5</option>';tpLabel.append(tp);document.querySelector('.live-badge').before(tpLabel);
  tp.onchange=()=>{const multiple=Number(tp.value);tp.value=String(state?.takeProfitMultiple??2);tp.disabled=true;action(()=>api('/api/trading/settings',{takeProfitMultiple:multiple})).finally(()=>{tp.disabled=false;});};

  const runButton = document.createElement('button'); runButton.type = 'button'; runButton.id = 'scan-control';
  document.querySelector('.live-badge').before(runButton);
  runButton.onclick = () => action(() => api('/api/control', { action: state?.running ? 'STOP' : 'START' }));
  const validAddress = address => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let value = 0n;
    for (const char of address) value = value * 58n + BigInt(alphabet.indexOf(char));
    let bytes = 0; while (value) { bytes++; value >>= 8n; }
    return bytes + (address.match(/^1*/)[0].length) === 32;
  };
  const available = () => Math.max(0, Math.floor((state?.live?.balanceSol ?? 0) * 1e9) - Math.ceil((state?.live?.caps?.reserve ?? 0) * 1e9) - 5000) / 1e9;
  function renderWithdrawal() {
    const amount = Number(el('trading-amount').value), destination = el('trading-destination').value.trim(), max = available();
    el('trading-available').textContent = `Khả dụng: ${max.toFixed(9)} SOL · đã giữ dự phòng và phí`;
    el('trading-amount').max = String(max);
    const error = destination && (!validAddress(destination) || destination === state?.live?.owner) ? 'Nhập địa chỉ Solana hợp lệ, khác ví trading.' : amount > max ? 'Vượt số dư khả dụng sau dự phòng SOL và phí.' : '';
    el('trading-error').textContent = error;
    el('trading-submit').disabled = withdrawing || busy || !validAddress(destination) || !!error || !(amount > 0) || state?.network !== 'SOLANA' || !!state?.live?.pendingSignature;
    el('trading-amount').disabled = el('trading-destination').disabled = withdrawing;
    for (const id of ['all', 'half', 'quarter']) el('trading-' + id).disabled = withdrawing || busy || max <= 0;
  }
  async function loadDestination() {
    const value = await api('/api/trading/withdrawal-destination');
    if (value.network !== state?.network) return;
    destinationNetwork = value.network; el('trading-destination').value = value.destinationAddress; renderWithdrawal();
  }
  el('trading-destination').onchange = async () => {
    const address = el('trading-destination').value.trim();
    if (address && !validAddress(address)) return;
    try { await api('/api/trading/withdrawal-destination', { network: destinationNetwork, destinationAddress: address }); }
    catch { el('trading-error').textContent = 'Không lưu được địa chỉ nhận.'; }
  };
  el('trading-destination').oninput = el('trading-amount').oninput = renderWithdrawal;
  for (const [id, divisor] of [['all', 1], ['half', 2], ['quarter', 4]]) el('trading-' + id).onclick = () => {
    if (withdrawing) return;
    el('trading-amount').value = (Math.floor(available() * 1e9 / divisor) / 1e9).toFixed(9); renderWithdrawal();
  };
  el('trading-withdraw-form').onsubmit = async event => {
    event.preventDefault(); if (withdrawing || busy) return;
    renderWithdrawal(); if (el('trading-submit').disabled) return;
    const destinationAddress = el('trading-destination').value.trim(), amountSol = Number(el('trading-amount').value);
    if (!window.confirm(`Chuyển thật ${amountSol} SOL tới ${destinationAddress}?`)) return;
    withdrawing = true; renderWithdrawal(); message('Đang chờ xác nhận on-chain…');
    try {
      await api('/api/trading/withdrawal-destination', { network: state.network, destinationAddress });
      const result = await api('/api/wallet/withdraw', { destinationAddress, amountSol });
      state.live.balanceSol = result.solBalance; el('trading-amount').value = '';
      message(`Đã rút ${result.amountSol} SOL · tx ${result.signature.slice(0, 12)}`);
    } catch (error) {
      message('');
      const errors = { LIVE_INSUFFICIENT_SOL: 'Vượt số dư SOL hiện có.', LIVE_SOL_RESERVE: 'Không đủ SOL sau khi giữ dự phòng và phí.', LIVE_DESTINATION_INVALID: 'Địa chỉ nhận Solana không hợp lệ.', LIVE_AMOUNT_INVALID: 'Nhập số SOL hợp lệ, tối đa 9 chữ số thập phân.' };
      el('trading-error').textContent = errors[error.message] || error.message;
    } finally {
      const error = el('trading-error').textContent;
      withdrawing = false; render(); el('trading-error').textContent = error;
    }
  };
  function open(panel) { el('wallet-panel').hidden = false; el('wallet-summary').setAttribute('aria-expanded', 'true'); el('trading-deposit-panel').hidden = panel !== 'deposit'; el('trading-withdraw-form').hidden = panel !== 'withdraw'; }
  function close() { el('wallet-panel').hidden = true; el('wallet-summary').setAttribute('aria-expanded', 'false'); }
  el('wallet-summary').onclick = () => el('wallet-panel').hidden ? open('deposit') : close();
  el('wallet-close').onclick = close;
  el('trading-deposit').onclick = () => open('deposit');
  el('trading-withdraw').onclick = () => { open('withdraw'); action(async () => { const live = await api('/api/wallet/trading'); state.live = live; await loadDestination(); }); };
  el('trading-copy').onclick = el('deposit-copy').onclick = () => action(async () => { await navigator.clipboard.writeText(state.live.owner); message('Đã sao chép địa chỉ'); });
  el('trading-refresh').onclick = () => action(() => api('/api/wallet/trading'));
  el('trading-create').onclick = () => action(() => api('/api/wallet/trading', { confirm: '' }));
  function render() {
    const live = state?.live, armed = state?.mode === 'live';
    el('trading-address').textContent = el('deposit-address').textContent = live?.owner ?? 'Chưa tạo ví';
    el('trading-sol').textContent = live?.balanceSol == null ? '—' : `${live.balanceSol.toFixed(4)} SOL`;
    el('wallet-summary-state').textContent = live?.balanceSol == null ? 'Số dư chưa xác minh' : 'SOL on-chain';
    el('trading-create').hidden = !!live?.hasKey;
    el('trading-copy').disabled = el('deposit-copy').disabled = !live?.owner || busy;
    el('trading-cap').textContent = `Giới hạn mỗi vị thế: $${live?.caps?.position ?? 1} · ${armed ? 'LIVE-ARMED' : 'Chưa bật LIVE'}`;
    runButton.textContent = state?.running ? 'STOP' : 'QUÉT AN TOÀN'; runButton.disabled = busy;
    tp.value = String(state?.takeProfitMultiple ?? 2);
    const badge = document.querySelector('.live-badge');
    badge.setAttribute('aria-label', armed ? 'DISARM live trading' : 'LIVE real money');
    badge.title = state?.mode === 'live' ? 'STOP live trading' : 'LIVE: giao dịch tiền thật';
    badge.dataset.armed = String(armed);
    for (const node of badge.childNodes) if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) node.textContent = armed ? 'LIVE-ARMED · DISARM ' : state?.mode === 'safe' ? 'SAFE · LIVE ' : 'LIVE ';
    renderWithdrawal();
  }
  async function refresh() { state = await api('/api/control'); render(); }
  async function action(fn) {
    if (busy) return; busy = true; message('');
    try { await fn(); await refresh(); } catch (error) { message(error.message); }
    finally { busy = false; render(); }
  }
  const badge = document.querySelector('.live-badge'); badge.setAttribute('role', 'button'); badge.tabIndex = 0;
  badge.onclick = () => action(async () => {
    await refresh();
    const actionName = state.mode === 'live' ? 'DISARM' : 'LIVE';
    if (actionName === 'LIVE') {
      if (!state.live?.hasKey) { el('wallet-panel').hidden = false; el('wallet-summary').setAttribute('aria-expanded', 'true'); message('Tạo ví trading và nạp SOL trước khi bật LIVE.'); return; }
      el('live-confirm-detail').textContent = `Bot sẽ giao dịch bằng tiền thật. Giới hạn $${state.live.caps.position}/vị thế. Ví: ${state.live.owner}`;
      dialog.querySelector('input').value = ''; dialog.returnValue = ''; dialog.showModal(); return;
    }
    await api('/api/control', { action: actionName });
  });
  badge.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); badge.click(); } };

  root.addEventListener('keydown', event => { if (event.key === 'Escape') { close(); el('wallet-summary').focus(); } });
  refresh().then(loadDestination).catch(error => message(error.message));
  const controlStream = new EventSource('/api/events');
  controlStream.addEventListener('state', event => {
    try { const view = JSON.parse(event.data); if (view.control) { state = view.control; render(); if (destinationNetwork !== state.network) void loadDestination().catch(() => {}); } } catch {}
  });
  window.addEventListener('pagehide', () => controlStream.close());
})();
