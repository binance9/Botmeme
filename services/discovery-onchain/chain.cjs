'use strict';
const { createHash } = require('node:crypto');
// Lazy load so an unavailable optional network dependency cannot crash paper control.
const sdk = () => require('@solana/web3.js');
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const RAYDIUM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const SOL = 'So11111111111111111111111111111111111111112';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
// pump.fun create_v2 mints are Token-2022 accounts; same parsed shape, different owner program.
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const isTokenProgram = value => value === TOKEN || value === TOKEN_2022;
const key = value => new (sdk().PublicKey)(value);
const str = value => value?.toBase58?.() ?? value;
function decode58(text) {
  let n = 0n;
  for (const char of text) { const digit = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(char); if (digit < 0) throw Error('INSTRUCTION_INVALID'); n = n * 58n + BigInt(digit); }
  const bytes = []; while (n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const char of text) { if (char !== '1') break; bytes.unshift(0); }
  return Buffer.from(bytes);
}
const createTag = createHash('sha256').update('global:create').digest().subarray(0, 8);
// pump.fun migrated new token creation to create_v2; same first-4 accounts layout.
const createTagV2 = createHash('sha256').update('global:create_v2').digest().subarray(0, 8);
function extract(tx, program) {
  if (!tx?.meta || tx.meta.err) throw Error('TRANSACTION_UNAVAILABLE');
  const instructions = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap(row => row.instructions)];
  const found = [];
  for (const ix of instructions) {
    if (str(ix.programId) !== program || !ix.accounts || !ix.data) continue;
    const data = decode58(ix.data), accounts = ix.accounts.map(str);
    if (program === PUMP && (data.subarray(0, 8).equals(createTag) || data.subarray(0, 8).equals(createTagV2)) && accounts.length >= 5) {
      // Verify PDA and token vault later, never trust an arbitrary log's mint string.
      found.push({ token: accounts[0], pool: accounts[2], vault: accounts[3], program });
    } else if (program === RAYDIUM && data.length === 26 && data[0] === 1 && accounts.length >= 21) {
      const side = accounts[9] === SOL ? 8 : accounts[8] === SOL ? 9 : null;
      if (side !== null) found.push({ token: accounts[side], pool: accounts[4], vault: accounts[side + 2], quoteVault: accounts[side === 8 ? 11 : 10], program });
    }
  }
  if (!found.length) throw Error('UNSUPPORTED_CREATE_INSTRUCTION');
  return found;
}
function connect({ httpEndpoint, wsEndpoint, onFault }) {
  const rpc = new (sdk().Connection)(httpEndpoint, { commitment: 'confirmed', wsEndpoint, disableRetryOnRateLimit: true,
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(10000) }) });
  // web3 v1 has no public socket lifecycle API. Isolate this pinned-version bridge here.
  const socket = rpc._rpcWebSocket;
  // The service owns reconnect timing, including the 60s rate-limit cooldown.
  socket.setAutoReconnect(false);
  socket.on('error', onFault); socket.on('close', onFault);
  return { rpc, dispose(ids) {
    socket.off('error', onFault); socket.off('close', onFault);
    for (const id of ids) Promise.resolve(rpc.removeOnLogsListener(id)).catch(() => {});
    socket.close(1000);
  } };
}
async function filter(rpc, item, maxTop10Pct, { publicKey = key } = {}) {
  const mint = await rpc.getParsedAccountInfo(publicKey(item.token), 'confirmed');
  const info = mint.value?.data?.parsed?.info;
  if (!isTokenProgram(str(mint.value?.owner)) || mint.value?.data?.parsed?.type !== 'mint' || !info?.isInitialized) throw Error('MINT_UNVERIFIED');
  if (info.mintAuthority !== null) throw Error('MINT_AUTHORITY_ACTIVE');
  if (info.freezeAuthority !== null) throw Error('FREEZE_AUTHORITY_ACTIVE');
  const vault = await rpc.getParsedAccountInfo(publicKey(item.vault), 'confirmed');
  const vi = vault.value?.data?.parsed?.info;
  if (!isTokenProgram(str(vault.value?.owner)) || vi?.mint !== item.token) throw Error('VAULT_UNVERIFIED');
  const authority = item.program === PUMP ? item.pool : sdk().PublicKey.findProgramAddressSync([Buffer.from('amm authority')], key(RAYDIUM))[0].toBase58();
  if (vi.owner !== authority) throw Error('VAULT_AUTHORITY_INVALID');
  if (item.quoteVault) {
    const quote = await rpc.getParsedAccountInfo(publicKey(item.quoteVault), 'confirmed');
    const qi = quote.value?.data?.parsed?.info;
    if (!isTokenProgram(str(quote.value?.owner)) || qi?.mint !== SOL || qi.owner !== authority) throw Error('QUOTE_VAULT_UNVERIFIED');
  }
  const [largest, supply] = await Promise.all([rpc.getTokenLargestAccounts(publicKey(item.token), 'confirmed'), rpc.getTokenSupply(publicKey(item.token), 'confirmed')]);
  const total = BigInt(supply.value.amount);
  if (total <= 0n || !largest.value?.length || supply.value.decimals !== info.decimals) throw Error('SUPPLY_UNVERIFIED');
  const rows = largest.value.filter(row => str(row.address) !== item.vault).map(row => BigInt(row.amount));
  rows.sort((a, b) => a > b ? -1 : a < b ? 1 : 0);
  const top = rows.slice(0, 10).reduce((sum, n) => sum + n, 0n);
  if (top < 0n || top > total) throw Error('HOLDERS_UNVERIFIED');
  if (top * 10000n > total * BigInt(Math.round(maxTop10Pct * 100))) throw Error('TOP10_CONCENTRATION');
  return { decimals: info.decimals, supply: Number(total) / 10 ** info.decimals, top10Pct: Number(top * 10000n / total) / 100 };
}
function createQuoteReader({ now = () => new Date(), fetcher = fetch } = {}) {
  let cached = null;
  return async (rpc, item, mint) => {
    if (!cached || now().getTime() - cached.at > 30000) {
      const res = await fetcher('https://api.exchange.coinbase.com/products/SOL-USD/trades?limit=1', { signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (!res.ok) throw Error('USD_QUOTE_UNAVAILABLE');
      const row = (await res.json())[0], age = now().getTime() - Date.parse(row?.time);
      if (!(Number(row?.price) > 0) || !Number.isFinite(age) || age < 0 || age > 60000) throw Error('USD_QUOTE_STALE');
      cached = { price: Number(row.price), at: Date.parse(row.time) };
    }
    let ratio, liquiditySol;
    if (item.program === PUMP) {
      const expected = sdk().PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), key(item.token).toBuffer()], key(PUMP))[0].toBase58();
      if (item.pool !== expected) throw Error('CURVE_PDA_INVALID');
      const account = await rpc.getAccountInfo(key(item.pool), 'confirmed'), data = account?.data;
      const tag = createHash('sha256').update('account:BondingCurve').digest().subarray(0, 8);
      if (str(account?.owner) !== PUMP || !data || data.length < 49 || !data.subarray(0, 8).equals(tag) || data[48]) throw Error('CURVE_UNVERIFIED');
      const tokens = Number(data.readBigUInt64LE(8)) / 10 ** mint.decimals;
      ratio = (Number(data.readBigUInt64LE(16)) / 1e9) / tokens;
      liquiditySol = Number(data.readBigUInt64LE(32)) / 1e9;
    } else {
      const [base, quote] = await Promise.all([rpc.getTokenAccountBalance(key(item.vault), 'confirmed'), rpc.getTokenAccountBalance(key(item.quoteVault), 'confirmed')]);
      const tokens = Number(base.value.amount) / 10 ** base.value.decimals;
      const sol = Number(quote.value.amount) / 10 ** quote.value.decimals;
      ratio = sol / tokens; liquiditySol = 2 * sol;
    }
    const price = ratio * cached.price, liquidityUsd = liquiditySol * cached.price, marketCapUsd = price * mint.supply;
    if (![price, liquidityUsd, marketCapUsd].every(Number.isFinite) || price <= 0 || liquidityUsd < 0) throw Error('POOL_QUOTE_UNVERIFIED');
    return { price, liquidityUsd, marketCapUsd };
  };
}
module.exports = { PUMP, RAYDIUM, SOL, TOKEN, key, extract, connect, filter, createQuoteReader };
