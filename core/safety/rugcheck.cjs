'use strict';
// RugCheck adapter — real on-chain safety metadata for Solana tokens.
// Live contract verified 2026-09-27 against GET /v1/tokens/{mint}/report (BONK).
// Returns a normalized verdict or throws (fail-closed: the gate REJECTs when
// on-chain safety cannot be verified).
const SAFETY_TIMEOUT_MS = 8000;
const { PublicKey } = require('@solana/web3.js');
const { createHash } = require('node:crypto');
const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];
const ASSOCIATED_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const CURVE_DISCRIMINATOR = createHash('sha256').update('account:BondingCurve').digest().subarray(0, 8);
function rawAmount(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 20 || BigInt(value) > 18446744073709551615n) throw Error('SOLANA_RPC_INVALID_AMOUNT');
  return BigInt(value);
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
    if (!resp.ok) throw Error('RUGCHECK_HTTP_' + resp.status);
    return await resp.json();
  } finally { clearTimeout(timer); }
}

function normalizeReport(data) {
  const token = data && typeof data === 'object' ? data.token : null;
  if (!token || typeof token !== 'object') throw Error('RUGCHECK_UNPARSABLE_TOKEN');
  if (typeof token.mintAuthority !== 'string' && token.mintAuthority !== null) throw Error('RUGCHECK_UNPARSABLE_MINT_AUTHORITY');
  if (typeof token.freezeAuthority !== 'string' && token.freezeAuthority !== null) throw Error('RUGCHECK_UNPARSABLE_FREEZE_AUTHORITY');
  const markets = Array.isArray(data.markets) ? data.markets : [];
  const holders = Array.isArray(data.topHolders) ? data.topHolders : [];
  const lpLockedPcts = markets.map(m => m && m.lp && typeof m.lp.lpLockedPct === 'number' ? m.lp.lpLockedPct : null).filter(v => v !== null);
  if (!lpLockedPcts.length) throw Error('RUGCHECK_UNPARSABLE_LIQUIDITY');
  const topHolderPcts = holders.map(h => typeof h.pct === 'number' ? h.pct : null).filter(v => v !== null);
  if (!topHolderPcts.length) throw Error('RUGCHECK_UNPARSABLE_HOLDERS');
  return {
    mintAuthorityRevoked: token.mintAuthority === null,
    freezeAuthorityRevoked: token.freezeAuthority === null,
    maxLpLockedPct: Math.max(...lpLockedPcts),
    top10HolderPct: topHolderPcts.slice(0, 10).reduce((sum, v) => sum + v, 0),
    insiderHolderPct: holders.filter(h => h.insider === true).reduce((sum, h) => sum + (h.pct || 0), 0),
    scoreNormalised: typeof data.score_normalised === 'number' ? data.score_normalised : null
  };
}

// createRugCheckReader({ baseUrl, timeoutMs }) -> async read(token) => metadata
// Tokens that are not Solana mints (other networks) throw RUGCHECK_UNSUPPORTED_NETWORK
// so the gate fails closed instead of buying unverified tokens.
function createRugCheckReader({ baseUrl = 'https://api.rugcheck.xyz', timeoutMs = SAFETY_TIMEOUT_MS } = {}) {
  return {
    network: 'SOLANA',
    async read(token) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(token))) throw Error('RUGCHECK_NOT_A_SOLANA_MINT');
      const data = await fetchJson(baseUrl + '/v1/tokens/' + encodeURIComponent(token) + '/report', timeoutMs);
      return normalizeReport(data);
    }
  };
}

// Fallback reader — verifies what Solana RPC can prove directly when RugCheck
// has no data for a brand-new pool (HTTP 400) or is unreachable: mint/freeze
// authority and top-10 holder concentration. LP lock and insider flagging are
// NOT computable from plain RPC. A verified, incomplete pump curve substitutes
// for traditional LP evidence; other tokens still require LP evidence live.
function createSolanaRpcSafetyReader({ rpcUrl = 'https://api.mainnet-beta.solana.com', timeoutMs = SAFETY_TIMEOUT_MS, fetcher = fetch } = {}) {
  if (typeof rpcUrl !== 'string' || !/^https:\/\//.test(rpcUrl) || typeof fetcher !== 'function' || typeof timeoutMs !== 'number' || timeoutMs <= 0) throw Error('INVALID_SOLANA_RPC_READER');
  async function call(method, params) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetcher(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctrl.signal });
      if (!resp.ok) throw Error('SOLANA_RPC_HTTP_' + resp.status);
      const data = await resp.json();
      if (!data || data.error || !Object.hasOwn(data, 'result')) throw Error('SOLANA_RPC_INVALID');
      return data.result;
    } finally { clearTimeout(timer); }
  }
  return {
    network: 'SOLANA',
    async read(token) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(token))) throw Error('SOLANA_RPC_NOT_A_MINT');
      const account = await call('getAccountInfo', [token, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
      const info = account?.value?.data?.parsed?.info;
      if (!info || account.value.data.parsed.type !== 'mint' || !TOKEN_PROGRAMS.includes(account.value.owner) || account.value.executable !== false || info.isInitialized !== true) throw Error('SOLANA_RPC_MINT_MISSING');
      for (const key of ['mintAuthority', 'freezeAuthority']) {
        if (info[key] !== null && (typeof info[key] !== 'string' || !info[key])) throw Error('SOLANA_RPC_AUTHORITY_MISSING');
      }
      // Pump mints are owned by the token program, not pump. Prove origin via
      // the canonical curve PDA, program owner, discriminator and complete bit.
      // Neither a mint suffix nor a discovery-supplied pool address is evidence.
      const mint = new PublicKey(token);
      const curve = PublicKey.findProgramAddressSync([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM)[0];
      const curveResult = await call('getAccountInfo', [curve.toBase58(), { encoding: 'base64', commitment: 'confirmed' }]);
      if (!curveResult || !Object.hasOwn(curveResult, 'value')) throw Error('SOLANA_RPC_CURVE_MISSING');
      let curveVault = null;
      if (curveResult.value !== null) {
        const c = curveResult.value;
        if (c.owner !== PUMP_PROGRAM.toBase58() || c.executable !== false || c.data?.[1] !== 'base64' || typeof c.data[0] !== 'string') throw Error('SOLANA_RPC_CURVE_INVALID');
        const bytes = Buffer.from(c.data[0], 'base64');
        if (bytes.length < 49 || !bytes.subarray(0, 8).equals(CURVE_DISCRIMINATOR) || bytes[48] > 1) throw Error('SOLANA_RPC_CURVE_INVALID');
        if (bytes[48] === 0) {
          curveVault = PublicKey.findProgramAddressSync([curve.toBuffer(), new PublicKey(account.value.owner).toBuffer(), mint.toBuffer()], ASSOCIATED_PROGRAM)[0].toBase58();
        }
      }
      const [largest, supply] = [await call('getTokenLargestAccounts', [token, { commitment: 'confirmed' }]), await call('getTokenSupply', [token, { commitment: 'confirmed' }])];
      const total = rawAmount(supply?.value?.amount);
      if (total === 0n || !Array.isArray(largest?.value) || !largest.value.length) throw Error('SOLANA_RPC_HOLDERS_MISSING');
      const seen = new Set();
      const rows = largest.value.map(row => {
        if (!row || typeof row.address !== 'string' || !row.address || seen.has(row.address)) throw Error('SOLANA_RPC_HOLDERS_INVALID');
        seen.add(row.address);
        return { address: row.address, amount: rawAmount(row.amount) };
      }).sort((a, b) => a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0);
      if (rows.reduce((sum, row) => sum + row.amount, 0n) > total) throw Error('SOLANA_RPC_SUPPLY_INCONSISTENT');
      // Only the program's derived liquidity vault is excluded. A whale is
      // always counted, even when it owns >=40% or matches snapshot.poolAddress.
      const top = rows.filter(row => row.address !== curveVault).slice(0, 10);
      const numerator = top.reduce((sum, row) => sum + row.amount, 0n) * 100n;
      // Sum raw u64 amounts exactly; only the final JSON percentage is a Number.
      const top10HolderPct = Number(numerator / total) + Number(numerator % total) / Number(total);
      return {
        mintAuthorityRevoked: info.mintAuthority === null,
        freezeAuthorityRevoked: info.freezeAuthority === null,
        maxLpLockedPct: null,
        ...(curveVault ? { lpStatus: 'bonding-curve' } : {}),
        top10HolderPct,
        insiderHolderPct: null,
        scoreNormalised: null
      };
    }
  };
}

// Composite chain: the primary provider answers when it can; only a primary
// failure (RugCheck outage, HTTP 400 for brand-new pools, timeout) promotes the
// fallback. If the fallback also fails, the primary error surfaces so the gate
// stays fail-closed.
function createFallbackSafetyReader({ primary, fallback } = {}) {
  if (!primary || typeof primary.read !== 'function' || !fallback || typeof fallback.read !== 'function') throw Error('INVALID_SAFETY_READER_CHAIN');
  return {
    network: primary.network ?? fallback.network,
    async read(token, snapshot) {
      try { return await primary.read(token, snapshot); }
      catch (primaryError) {
        try { return await fallback.read(token, snapshot); }
        catch { throw primaryError; }
      }
    }
  };
}

module.exports = { createRugCheckReader, createSolanaRpcSafetyReader, createFallbackSafetyReader, normalizeReport, SAFETY_TIMEOUT_MS };
