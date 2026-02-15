// examples/client.ts
// Example: L402 client that auto-pays for API access
//
// Run with: npx ts-node examples/client.ts
// (Make sure the example server is running first)

import { createL402Client, LndConfig } from '../src';

// Configure your LND node (the one that will PAY for services)
const node: LndConfig = {
  restHost: process.env.LND_REST_HOST || 'https://127.0.0.1:8081',
  macaroon: process.env.LND_MACAROON || 'YOUR_MACAROON_HEX_HERE',
  skipTlsVerify: true,
};

const client = createL402Client({
  node,
  maxAutoPaySats: 1000, // Won't auto-pay more than 1000 sats
});

const API = process.env.API_URL || 'http://localhost:3000';

async function main() {
  console.log('=== L402 Client Demo ===\n');

  // 1. Discover available services (free)
  console.log('--- Discovering services ---');
  const menu = await client.fetch(`${API}/`);
  console.log('Services:', JSON.stringify(menu.data.endpoints, null, 2));
  console.log(`Paid: ${menu.paid}\n`);

  // 2. Buy a joke (10 sats)
  console.log('--- Buying a joke (10 sats) ---');
  const joke = await client.fetch(`${API}/api/joke`);
  console.log(`Joke: ${joke.data.joke}`);
  console.log(`Paid: ${joke.paid} | Price: ${joke.price} sats`);
  console.log(`Preimage: ${joke.preimage?.substring(0, 20)}...\n`);

  // 3. Buy wisdom (50 sats)
  console.log('--- Buying wisdom (50 sats) ---');
  const wisdom = await client.fetch(`${API}/api/wisdom`);
  console.log(`Wisdom: ${wisdom.data.wisdom}`);
  console.log(`Paid: ${wisdom.paid} | Price: ${wisdom.price} sats\n`);

  // 4. Show token cache
  console.log(`Cached tokens: ${client.cacheSize()}`);
  console.log('(Cached tokens are reused for subsequent requests)');

  // 5. Total spent
  const totalSpent = (joke.price || 0) + (wisdom.price || 0);
  console.log(`\nTotal spent: ${totalSpent} sats`);
}

main().catch(console.error);
