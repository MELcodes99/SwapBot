import 'dotenv/config';
import fs from 'node:fs';
import { Bot, InlineKeyboard } from 'grammy';
import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { createX402Client } from 'x402-solana/client';
import bs58 from 'bs58';

// ---------- config ----------
const HERMES = 'https://hermes.swap.io';
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const OWNER = Number(process.env.OWNER_TELEGRAM_ID);
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS || 50);
const MAX_FEE_ATOMIC = BigInt(process.env.MAX_FEE_ATOMIC || 10_000); // $0.01 cap per API call
const QUOTE_TTL_MS = 30_000;

if (!process.env.BOT_TOKEN || !(process.env.PAYER_KEYPAIR || process.env.PAYER_KEYPAIR_JSON) || !OWNER) {
  console.error('Missing BOT_TOKEN, PAYER_KEYPAIR or OWNER_TELEGRAM_ID in .env');
  process.exit(1);
}

// Keypair is loaded from a file path and never printed or sent anywhere.
const wallet = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(process.env.PAYER_KEYPAIR_JSON || fs.readFileSync(process.env.PAYER_KEYPAIR, 'utf8')))
);
const connection = new Connection(RPC, 'confirmed');

// x402 client: on a 402 it signs a USDC payment and retries automatically.
const x402 = createX402Client({
  wallet: {
    address: wallet.publicKey.toBase58(),
    signTransaction: async (tx) => {
      tx.sign([wallet]);
      return tx;
    },
  },
  network: 'solana',
  rpcUrl: RPC,
  amount: MAX_FEE_ATOMIC,
});

// ---------- tokens ----------
const TOKENS = {
  SOL: { mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
  USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  USDT: { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
};

async function resolveToken(input) {
  const sym = input.toUpperCase();
  if (TOKENS[sym]) return { symbol: sym, ...TOKENS[sym] };
  // otherwise treat it as a mint address and read decimals from chain
  const info = await connection.getParsedAccountInfo(new PublicKey(input));
  const decimals = info.value?.data?.parsed?.info?.decimals;
  if (decimals === undefined) throw new Error(`Unknown token: ${input}`);
  return { symbol: input.slice(0, 4) + '…', mint: input, decimals };
}

function toAtomic(amount, decimals) {
  if (!/^\d+(\.\d+)?$/.test(amount)) throw new Error(`Bad amount: ${amount}`);
  const [whole, frac = ''] = amount.split('.');
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals))).toString();
}

function fromAtomic(atomic, decimals) {
  if (atomic === undefined || atomic === null) return '?';
  const s = BigInt(atomic).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals) || '0';
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

// first defined value among several possible field names
const pick = (obj, ...paths) => {
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => o?.[k], obj);
    if (v !== undefined && v !== null) return v;
  }
};

// ---------- Hermes API ----------
async function hermes(path, body) {
  const res = await x402.fetch(`${HERMES}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  const receipt = res.headers.get('x-payment-response') || res.headers.get('payment-response');
  if (!receipt) console.warn(`${path}: 200 without payment receipt (not charged)`);
  return JSON.parse(text);
}

// ---------- bot ----------
const bot = new Bot(process.env.BOT_TOKEN);
const pending = new Map(); // id -> { best, from, to, amount, expires }

// Only the owner can use this bot: it spends from your wallet.
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== OWNER) return ctx.reply('🔒 This is a private bot.');
  return next();
});

bot.command(['start', 'help'], (ctx) =>
  ctx.reply(
    '🤖 SWAP BOT — Solana swaps via Swap.io\n\n' +
      '💱 /quote 0.1 SOL USDC – best route (~$0.003)\n' +
      '🪙 /quote 5 USDC <mint> – any token by mint\n' +
      '💰 /balance – wallet balances\n' +
      '👛 /wallet – bot wallet address\n\n' +
      '✅ Every swap asks you to confirm first.'
  )
);

bot.command('wallet', (ctx) => ctx.reply(`👛 *Bot wallet*\n\`${wallet.publicKey.toBase58()}\``, { parse_mode: 'Markdown' }));

bot.command('balance', async (ctx) => {
  const sol = await connection.getBalance(wallet.publicKey);
  const accs = await connection.getParsedTokenAccountsByOwner(wallet.publicKey, {
    mint: new PublicKey(TOKENS.USDC.mint),
  });
  const usdc = accs.value.reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
  await ctx.reply(`💰 *Balances*\n\n◎ SOL: ${sol / 1e9}\n💵 USDC: ${usdc}`, { parse_mode: 'Markdown' });
});

bot.command('quote', async (ctx) => {
  const [amount, fromArg, toArg] = ctx.match.trim().split(/\s+/);
  if (!amount || !fromArg || !toArg) return ctx.reply('ℹ️ Usage: /quote 0.1 SOL USDC');

  const msg = await ctx.reply('🔎 Fetching quotes…');
  const from = await resolveToken(fromArg);
  const to = await resolveToken(toArg);

  const data = await hermes('/v1/swap/quote', {
    input: { token: from.mint, amount: toAtomic(amount, from.decimals), chainKey: 'sol' },
    output: { token: to.mint, chainKey: 'sol' },
    userAddress: wallet.publicKey.toBase58(),
    slippageBps: SLIPPAGE_BPS,
  });

  const best = data.quotes?.[0];
  if (!best) return ctx.api.editMessageText(ctx.chat.id, msg.message_id, '🚫 No route found.');

  const out = pick(best, 'outputAmount', 'output.amount', 'outAmount', 'amountOut');
  const minOut = pick(best, 'minOutputAmount', 'minimumOutput', 'minOutAmount', 'output.minAmount');
  const impact = pick(best, 'priceImpact', 'priceImpactPct');
  const provider = pick(best, 'provider.name', 'provider.key') ?? 'unknown';

  const id = Math.random().toString(36).slice(2, 10);
  pending.set(id, { best, from, to, amount, expires: Date.now() + QUOTE_TTL_MS });

  const text =
    `🏆 Best route: ${provider}\n\n` +
    `📤 You pay: ${amount} ${from.symbol}\n📥 You get: ~${fromAtomic(out, to.decimals)} ${to.symbol}\n` +
    (minOut ? `🛡️ Min received: ${fromAtomic(minOut, to.decimals)} ${to.symbol}\n` : '') +
    (impact !== undefined ? `📉 Price impact: ${impact}\n` : '') +
    `🔀 Other routes: ${(data.quotes.length || 1) - 1}\n\n` +
    `⏱️ Valid ~30s · 💸 ~$0.006 API fees + network fee`;

  await ctx.api.editMessageText(ctx.chat.id, msg.message_id, text, {
    reply_markup: new InlineKeyboard().text('✅ Swap', `go:${id}`).text('❌ Cancel', `no:${id}`),
  });
});

bot.callbackQuery(/^no:(.+)$/, async (ctx) => {
  pending.delete(ctx.match[1]);
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('❌ Cancelled.');
});

bot.callbackQuery(/^go:(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  const p = pending.get(id);
  pending.delete(id); // one-shot: can't double-tap into two swaps
  await ctx.answerCallbackQuery();
  if (!p) return ctx.editMessageText('🤷 Quote not found. Run /quote again.');
  if (Date.now() > p.expires) return ctx.editMessageText('⌛ Quote expired. Run /quote again.');

  await ctx.editMessageText('🛠️ Building transaction…');

  // quoteResponse must be the raw providerQuote, not the wrapper
  const built = await hermes('/v1/swap/build-tx', {
    provider: p.best.provider.key,
    userAddress: wallet.publicKey.toBase58(),
    chainKey: 'sol',
    quoteResponse: p.best.providerQuote,
  });

  const rawTx = pick(built, 'transaction', 'tx', 'swapTransaction', 'serializedTransaction', 'data.transaction', 'data.tx', 'transactions.0', 'result.transaction');
  if (typeof rawTx !== 'string') {
    console.log('build-tx response:', JSON.stringify(built, null, 2));
    throw new Error('No transaction found in build-tx response (full response printed in terminal)');
  }
  const tx = VersionedTransaction.deserialize(Buffer.from(rawTx, 'base64'));
  tx.sign([wallet]);

  await ctx.editMessageText('📡 Submitting to Solana…');
  const sub = await hermes('/v1/swap/submit-tx', {
    signedTransaction: Buffer.from(tx.serialize()).toString('base64'),
    provider: p.best.provider.key,
    chainKey: 'sol',
  });
  // Use the signature from the tx we signed; fall back to whatever Hermes returns.
  const localSig = bs58.encode(tx.signatures[0]);
  const sig = pick(sub, 'transactionHash', 'signature', 'txid', 'txHash', 'hash', 'data.transactionHash') || localSig;
  console.log('submit-tx response:', JSON.stringify(sub));

  // Confirm via our own RPC (free) instead of paying for /v1/swap/status polls.
  const deadline = Date.now() + 60_000;
  let status = 'pending';
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([sig]);
    const s = value[0];
    if (s?.err) { status = 'failed'; break; }
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') { status = 'confirmed'; break; }
    await new Promise((r) => setTimeout(r, 2000));
  }

  const link = `https://solscan.io/tx/${sig}`;
  const label = { confirmed: '✅ Swap confirmed', failed: '❌ Swap failed', pending: '⏳ Still pending after 60s' }[status];
  await ctx.editMessageText(`${label}\n\n🔁 ${p.amount} ${p.from.symbol} → ${p.to.symbol}\n🔗 ${link}`);
});

bot.catch(async (err) => {
  console.error(err.error);
  try { await err.ctx.reply(`⚠️ Error: ${err.error.message}`); } catch {}
});

setInterval(() => {
  for (const [id, p] of pending) if (Date.now() > p.expires) pending.delete(id);
}, 60_000);

await bot.api.setMyCommands([
  { command: 'quote', description: 'Get best swap route, e.g. /quote 0.1 SOL USDC' },
  { command: 'balance', description: 'Show wallet SOL and USDC balances' },
  { command: 'wallet', description: 'Show the bot wallet address' },
  { command: 'help', description: 'How to use this bot' },
]);
bot.start();
console.log(`Bot running. Wallet: ${wallet.publicKey.toBase58()}`);
