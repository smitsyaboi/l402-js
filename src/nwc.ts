// src/nwc.ts
// NWC (Nostr Wallet Connect / NIP-47) adapter for l402-js middleware.
//
// Enables the L402 middleware to create Lightning invoices through any
// NWC-compatible wallet (Alby Hub, Zeus, etc.) instead of requiring a
// direct LND REST API connection.
//
// Only implements make_invoice — the server never pays invoices.
// Payment verification is cryptographic (sha256(preimage) == paymentHash)
// and requires no wallet round-trip.

import { getPublicKey, finishEvent, nip04 } from 'nostr-tools';
import WebSocket from 'ws';

// ── Connection string parsing ─────────────────────────────────────────────────
//
// Format: nostr+walletconnect://<wallet_pubkey>?relay=<url>&secret=<hex>
// The secret is the app's private key — used to derive its keypair and
// to encrypt/decrypt NIP-04 messages with the wallet.

export interface ParsedNwcConnection {
  walletPubkey: string;
  relayUrl: string;
  secretKeyHex: string;
}

export function parseNwcConnectionString(connectionString: string): ParsedNwcConnection {
  if (!connectionString.startsWith('nostr+walletconnect://')) {
    throw new Error('NWC connection string must start with nostr+walletconnect://');
  }

  const body = connectionString.slice('nostr+walletconnect://'.length);
  const qi = body.indexOf('?');
  if (qi === -1) throw new Error('Invalid NWC connection string: missing query parameters');

  const walletPubkey = body.slice(0, qi);
  const params = new URLSearchParams(body.slice(qi + 1));
  const relayUrl = params.get('relay');
  const secretKeyHex = params.get('secret');

  if (!walletPubkey) throw new Error('Invalid NWC connection string: missing wallet pubkey');
  if (!relayUrl)     throw new Error('Invalid NWC connection string: missing relay URL');
  if (!secretKeyHex) throw new Error('Invalid NWC connection string: missing secret');

  return { walletPubkey, relayUrl, secretKeyHex };
}

// ── Invoice creation ──────────────────────────────────────────────────────────

export async function nwcCreateInvoice(
  connectionString: string,
  amountSats: number,
  description: string,
  timeoutMs = 10_000,
): Promise<{ invoice: string; paymentHash: string }> {
  const { walletPubkey, relayUrl, secretKeyHex } = parseNwcConnectionString(connectionString);
  const appPubkey = getPublicKey(secretKeyHex);

  // Encrypt the make_invoice request using NIP-04 (AES-256-CBC + ECDH shared secret)
  const requestPayload = JSON.stringify({
    method: 'make_invoice',
    params: {
      amount: amountSats * 1000, // NWC uses millisatoshis
      description,
      expiry: 3600,
    },
  });

  const encryptedContent = await nip04.encrypt(secretKeyHex, walletPubkey, requestPayload);

  // Build and sign the NIP-47 request event (kind 23194)
  const requestEvent = finishEvent(
    {
      kind: 23194,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', walletPubkey]],
      content: encryptedContent,
    },
    secretKeyHex,
  );

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relayUrl);
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore close errors */ }
      fn();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`NWC make_invoice timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    ws.on('open', () => {
      // Subscribe to the wallet's response for this specific request event
      ws.send(JSON.stringify([
        'REQ', 'nwc-sub', {
          kinds: [23195],
          authors: [walletPubkey],
          '#e': [requestEvent.id],
        },
      ]));
      // Publish the request
      ws.send(JSON.stringify(['EVENT', requestEvent]));
    });

    ws.on('message', async (raw: Buffer) => {
      let msg: unknown[];
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!Array.isArray(msg) || msg[0] !== 'EVENT') return;
      const ev = msg[2] as { kind: number; pubkey: string; content: string } | undefined;
      if (!ev || ev.kind !== 23195 || ev.pubkey !== walletPubkey) return;

      try {
        const decrypted = await nip04.decrypt(secretKeyHex, walletPubkey, ev.content);
        const response = JSON.parse(decrypted) as {
          result_type: string;
          error?: { code: string; message: string };
          result?: { invoice: string; payment_hash: string };
        };

        if (response.error) {
          finish(() =>
            reject(new Error(`NWC error [${response.error!.code}]: ${response.error!.message}`))
          );
          return;
        }

        const invoice     = response.result?.invoice;
        const paymentHash = response.result?.payment_hash;

        if (!invoice || !paymentHash) {
          finish(() => reject(new Error('NWC response missing invoice or payment_hash')));
          return;
        }

        finish(() => resolve({ invoice, paymentHash }));
      } catch (e: any) {
        finish(() => reject(new Error(`NWC response handling failed: ${e.message}`)));
      }
    });

    ws.on('error', (err: Error) => {
      finish(() => reject(new Error(`NWC relay connection failed: ${err.message}`)));
    });
  });
}
