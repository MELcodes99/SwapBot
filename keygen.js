import fs from 'node:fs';
import { Keypair } from '@solana/web3.js';

const file = 'bot-wallet.json';
if (fs.existsSync(file)) {
  console.error(`${file} already exists — not overwriting it.`);
  process.exit(1);
}
const kp = Keypair.generate();
fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
console.log('Saved', file);
console.log('Address:', kp.publicKey.toBase58());
