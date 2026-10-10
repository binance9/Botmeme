'use strict';
const { createHash } = require('node:crypto');
const { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
const PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), TOKEN2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'), FEE = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
const pda = (name, seeds = [], program = PROGRAM) => PublicKey.findProgramAddressSync([Buffer.from(name), ...seeds.map(k => k.toBuffer())], program)[0];
const associated = (mint, owner, tokenProgram) => PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA)[0];
const discriminator = name => createHash('sha256').update('account:' + name).digest().subarray(0, 8);
const fail = cause => { throw Object.assign(Error('LIVE_PUMPFUN_UNAVAILABLE'), { pumpCause: cause }); };
function data(account, owner, name, length) {
  const label = name ?? 'Mint';
  if (!account) fail(label + '.account-missing');
  if (account.owner !== owner.toBase58()) fail(label + '.owner-mismatch');
  if (account.executable) fail(label + '.executable');
  if (account.data?.[1] !== 'base64' || typeof account.data[0] !== 'string') fail(label + '.encoding-invalid');
  const bytes = Buffer.from(account.data[0], 'base64');
  if (bytes.length < length) fail(label + '.layout-too-short');
  if (name && !bytes.subarray(0, 8).equals(discriminator(name))) fail(label + '.discriminator-mismatch');
  return bytes;
}
const ceilFee = (value, bps) => (value * bps + 9999n) / 10000n;
function expectations(side, amount, curve, protocol, creator) {
  let expected;
  if (side === 'BUY') {
    let net = amount * 10000n / (10000n + protocol + creator);
    const cost = net + ceilFee(net, protocol) + ceilFee(net, creator);
    if (cost > amount) net -= cost - amount;
    if (net <= 1n) fail('buy.net-too-small');
    expected = (net - 1n) * curve.tokens / (curve.sol + net - 1n);
    if (expected > curve.realTokens) expected = curve.realTokens;
  } else {
    const gross = amount * curve.sol / (curve.tokens + amount);
    if (gross > curve.realSol) fail('sell.insufficient-real-sol');
    expected = gross - ceilFee(gross, protocol) - ceilFee(gross, creator);
  }
  const minimum = expected * 9n / 10n; // Owner requested 90%: 1,000 bps, not 10 bps.
  if (minimum <= 0n) fail('minimum-output-zero');
  return { expected, minimum };
}
// Layout/account order: pump-fun/pump-public-docs idl/pump.json, checked 2026-10-05.
// buy (66063d1201daebea) is exact TOKENS. Exact SOL uses 38fc74089edfcd5f.
async function buildPumpfun({ rpc, mint: address, owner, side, amount }) {
  if (!['BUY', 'SELL'].includes(side) || !Number.isSafeInteger(amount) || amount <= 0) fail('invalid-order');
  const mint = new PublicKey(address), user = new PublicKey(owner), global = pda('global'), bondingCurve = pda('bonding-curve', [mint]), feeConfig = pda('fee_config', [PROGRAM], FEE);
  const read = async key => {
    try { return (await rpc('getAccountInfo', [key.toBase58(), { encoding: 'base64', commitment: 'confirmed' }])).value; }
    catch { fail('account-rpc-failed'); }
  };
  // Validate program ownership, never infer a pump coin from its mint suffix.
  const c = data(await read(bondingCurve), PROGRAM, 'BondingCurve', 49);
  if (c[48] !== 0) fail('BondingCurve.complete');
  const creator = c.length >= 81 ? new PublicKey(c.subarray(49, 81)) : PublicKey.default;
  // Legacy SOL instructions cannot trade non-SOL quote mints or mayhem curves.
  if (c[81]) fail('BondingCurve.mayhem-unsupported');
  if (c.length >= 115 && !new PublicKey(c.subarray(83, 115)).equals(PublicKey.default)) fail('BondingCurve.quote-mint-unsupported');
  const curve = { tokens: c.readBigUInt64LE(8), sol: c.readBigUInt64LE(16), realTokens: c.readBigUInt64LE(24), realSol: c.readBigUInt64LE(32) };
  if (!curve.tokens || !curve.sol) fail('BondingCurve.empty-reserves');
  const g = data(await read(global), PROGRAM, 'Global', 162), feeRecipient = new PublicKey(g.subarray(41, 73));
  let protocol = g.readBigUInt64LE(105), creatorBps = g.readBigUInt64LE(154);
  const feeAccount = await read(feeConfig);
  if (feeAccount) {
    const f = data(feeAccount, FEE, 'FeeConfig', 69), count = f.readUInt32LE(65);
    if (!count || count > 1000 || f.length < 69 + count * 40) fail('FeeConfig.invalid-tiers');
    const marketCap = curve.sol * c.readBigUInt64LE(40) / curve.tokens;
    let previous = -1n;
    for (let i = 0; i < count; i++) {
      const offset = 69 + i * 40, threshold = f.readBigUInt64LE(offset) + (f.readBigUInt64LE(offset + 8) << 64n);
      if (threshold <= previous) fail('FeeConfig.unordered-tiers'); previous = threshold;
      if (!i || marketCap >= threshold) { protocol = f.readBigUInt64LE(offset + 24); creatorBps = f.readBigUInt64LE(offset + 32); }
    }
  }
  if (creator.equals(PublicKey.default)) creatorBps = 0n;
  if (protocol + creatorBps >= 10000n) fail('fees-out-of-range');
  const mintAccount = await read(mint), tokenProgram = new PublicKey(mintAccount?.owner ?? PublicKey.default);
  if (!mintAccount) fail('Mint.account-missing');
  if (!tokenProgram.equals(TOKEN) && !tokenProgram.equals(TOKEN2022)) fail('Mint.owner-mismatch');
  const m = data(mintAccount, tokenProgram, null, 82);
  if (m[45] !== 1) fail('Mint.uninitialized');
  const associatedCurve = associated(mint, bondingCurve, tokenProgram), userAta = associated(mint, user, tokenProgram);
  const { expected, minimum } = expectations(side, BigInt(amount), curve, protocol, creatorBps);
  const key = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
  const vault = pda('creator-vault', [creator]), volume = pda('user_volume_accumulator', [user]);
  const keys = [key(global), key(feeRecipient, true), key(mint), key(bondingCurve, true), key(associatedCurve, true), key(userAta, true), key(user, true, true), key(SystemProgram.programId)];
  keys.push(...(side === 'BUY' ? [key(tokenProgram), key(vault, true)] : [key(vault, true), key(tokenProgram)]), key(pda('__event_authority')), key(PROGRAM));
  if (side === 'BUY') keys.push(key(pda('global_volume_accumulator')), key(volume, true));
  keys.push(key(feeConfig), key(FEE));
  // Cashback sell remaining accounts are optional; omit them and use the
  // documented creator-vault fallback instead of assuming a v2 PDA layout.
  const bytes = Buffer.alloc(side === 'BUY' ? 25 : 24);
  Buffer.from(side === 'BUY' ? '38fc74089edfcd5f' : '33e685a4017f83ad', 'hex').copy(bytes);
  bytes.writeBigUInt64LE(BigInt(amount), 8); bytes.writeBigUInt64LE(minimum, 16);
  const instructions = [];
  if (side === 'BUY') instructions.push(new TransactionInstruction({ programId: ATA, keys: [key(user, true, true), key(userAta, true), key(user), key(mint), key(SystemProgram.programId), key(tokenProgram)], data: Buffer.from([1]) }));
  instructions.push(new TransactionInstruction({ programId: PROGRAM, keys, data: bytes }));
  const block = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: user, recentBlockhash: block.value.blockhash, instructions }).compileToV0Message());
  return { tx, expected, minimum, decimals: m[44] };
}
module.exports = { buildPumpfun, expectations, PROGRAM };
