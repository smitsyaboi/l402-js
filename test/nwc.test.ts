import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// ── Hoisted mock classes (must be defined before vi.mock calls) ───────────────

const MockWebSocket = vi.hoisted(() => {
  const { EventEmitter } = require('events') as typeof import('events');

  class MockWS extends EventEmitter {
    static lastInstance: MockWS | null = null;
    sentMessages: string[] = [];

    constructor(_url: string) {
      super();
      MockWS.lastInstance = this;
      setTimeout(() => this.emit('open'), 0);
    }

    send(data: string) { this.sentMessages.push(data); }
    close() {}
  }

  return MockWS;
});

vi.mock('ws', () => ({ default: MockWebSocket }));

// ── nostr-tools mock ──────────────────────────────────────────────────────────

const APP_PUBKEY    = 'aabbccdd'.repeat(8);
const WALLET_PUBKEY = '11223344'.repeat(8);
const SECRET_HEX    = 'deadbeef'.repeat(8);

vi.mock('nostr-tools', () => ({
  getPublicKey: vi.fn(() => APP_PUBKEY),
  finishEvent:  vi.fn((template: Record<string, unknown>) => ({
    ...template,
    pubkey: APP_PUBKEY,
    id:     'mock-request-event-id',
    sig:    'mock-sig',
  })),
  nip04: {
    encrypt: vi.fn(async (_priv: string, _pub: string, text: string) =>
      `encrypted(${text})`
    ),
    decrypt: vi.fn(async (_priv: string, _pub: string, cipher: string) =>
      cipher.replace(/^encrypted\(/, '').replace(/\)$/, '')
    ),
  },
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { parseNwcConnectionString, nwcCreateInvoice } from '../src/nwc';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConnectionString(pubkey = WALLET_PUBKEY) {
  return `nostr+walletconnect://${pubkey}?relay=wss://relay.example.com&secret=${SECRET_HEX}`;
}

function makeNwcResponse(result: object) {
  const payload = JSON.stringify({ result_type: 'make_invoice', result });
  return JSON.stringify([
    'EVENT', 'nwc-sub', {
      kind: 23195,
      pubkey: WALLET_PUBKEY,
      content: `encrypted(${payload})`,
    },
  ]);
}

// ── parseNwcConnectionString ──────────────────────────────────────────────────

describe('parseNwcConnectionString', () => {
  it('parses a valid connection string', () => {
    const result = parseNwcConnectionString(makeConnectionString());
    expect(result.walletPubkey).toBe(WALLET_PUBKEY);
    expect(result.relayUrl).toBe('wss://relay.example.com');
    expect(result.secretKeyHex).toBe(SECRET_HEX);
  });

  it('throws for wrong scheme', () => {
    expect(() => parseNwcConnectionString('lightning:abcd')).toThrow(
      'must start with nostr+walletconnect://'
    );
  });

  it('throws when relay param is missing', () => {
    const cs = `nostr+walletconnect://${WALLET_PUBKEY}?secret=${SECRET_HEX}`;
    expect(() => parseNwcConnectionString(cs)).toThrow('missing relay URL');
  });

  it('throws when secret param is missing', () => {
    const cs = `nostr+walletconnect://${WALLET_PUBKEY}?relay=wss://relay.example.com`;
    expect(() => parseNwcConnectionString(cs)).toThrow('missing secret');
  });

  it('throws when query string is absent', () => {
    expect(() =>
      parseNwcConnectionString(`nostr+walletconnect://${WALLET_PUBKEY}`)
    ).toThrow('missing query parameters');
  });
});

// ── nwcCreateInvoice — happy path ─────────────────────────────────────────────

describe('nwcCreateInvoice — success', () => {
  beforeEach(() => {
    MockWebSocket.lastInstance = null;
    vi.clearAllMocks();
  });

  it('resolves with invoice and paymentHash from wallet response', async () => {
    const promise = nwcCreateInvoice(makeConnectionString(), 10, 'test payment');
    await new Promise(r => setTimeout(r, 10));

    MockWebSocket.lastInstance!.emit('message', Buffer.from(
      makeNwcResponse({ invoice: 'lnbc100n1test', payment_hash: 'abcdef1234' })
    ));

    const result = await promise;
    expect(result.invoice).toBe('lnbc100n1test');
    expect(result.paymentHash).toBe('abcdef1234');
  });

  it('sends a REQ subscription and then an EVENT to the relay', async () => {
    const promise = nwcCreateInvoice(makeConnectionString(), 10, 'desc');
    await new Promise(r => setTimeout(r, 10));

    MockWebSocket.lastInstance!.emit('message', Buffer.from(
      makeNwcResponse({ invoice: 'lnbc1', payment_hash: 'hash1' })
    ));
    await promise;

    const parsed = MockWebSocket.lastInstance!.sentMessages.map(m => JSON.parse(m));
    expect(parsed[0][0]).toBe('REQ');
    expect(parsed[1][0]).toBe('EVENT');
  });

  it('subscribes with #e filter matching the request event id', async () => {
    const promise = nwcCreateInvoice(makeConnectionString(), 10, 'desc');
    await new Promise(r => setTimeout(r, 10));

    MockWebSocket.lastInstance!.emit('message', Buffer.from(
      makeNwcResponse({ invoice: 'lnbc1', payment_hash: 'hash1' })
    ));
    await promise;

    const sub = JSON.parse(MockWebSocket.lastInstance!.sentMessages[0]);
    expect(sub[2]['#e']).toContain('mock-request-event-id');
  });

  it('converts sats to millisatoshis in the NWC request', async () => {
    const { nip04 } = await import('nostr-tools');
    const promise = nwcCreateInvoice(makeConnectionString(), 25, 'desc');
    await new Promise(r => setTimeout(r, 10));

    MockWebSocket.lastInstance!.emit('message', Buffer.from(
      makeNwcResponse({ invoice: 'lnbc1', payment_hash: 'hash1' })
    ));
    await promise;

    const encryptCall = vi.mocked(nip04.encrypt).mock.calls[0];
    const payload = JSON.parse(encryptCall[2]);
    expect(payload.params.amount).toBe(25_000);
  });
});

// ── nwcCreateInvoice — error paths ────────────────────────────────────────────

describe('nwcCreateInvoice — errors', () => {
  beforeEach(() => {
    MockWebSocket.lastInstance = null;
    vi.clearAllMocks();
  });

  it('rejects when wallet returns an error response', async () => {
    const promise = nwcCreateInvoice(makeConnectionString(), 10, 'desc');
    await new Promise(r => setTimeout(r, 10));

    const payload = JSON.stringify({
      result_type: 'make_invoice',
      error: { code: 'INSUFFICIENT_BALANCE', message: 'Not enough sats' },
    });
    MockWebSocket.lastInstance!.emit('message', Buffer.from(
      JSON.stringify(['EVENT', 'nwc-sub', {
        kind: 23195,
        pubkey: WALLET_PUBKEY,
        content: `encrypted(${payload})`,
      }])
    ));

    await expect(promise).rejects.toThrow('INSUFFICIENT_BALANCE');
  });

  it('rejects when wallet response is missing invoice', async () => {
    const promise = nwcCreateInvoice(makeConnectionString(), 10, 'desc');
    await new Promise(r => setTimeout(r, 10));

    MockWebSocket.lastInstance!.emit('message', Buffer.from(
      makeNwcResponse({ payment_hash: 'hash-only' })
    ));

    await expect(promise).rejects.toThrow('missing invoice or payment_hash');
  });

  it('rejects on WebSocket connection error', async () => {
    const promise = nwcCreateInvoice(makeConnectionString(), 10, 'desc');
    await new Promise(r => setTimeout(r, 10));

    MockWebSocket.lastInstance!.emit('error', new Error('ECONNREFUSED'));

    await expect(promise).rejects.toThrow('NWC relay connection failed');
  });

  it('rejects on timeout', async () => {
    const promise = nwcCreateInvoice(makeConnectionString(), 10, 'desc', 50);
    await expect(promise).rejects.toThrow('timed out after 50ms');
  });

  it('ignores events from unknown pubkeys', async () => {
    const promise = nwcCreateInvoice(makeConnectionString(), 10, 'desc', 80);
    await new Promise(r => setTimeout(r, 10));

    MockWebSocket.lastInstance!.emit('message', Buffer.from(
      JSON.stringify(['EVENT', 'nwc-sub', {
        kind: 23195,
        pubkey: 'wrong-pubkey',
        content: 'encrypted({})',
      }])
    ));

    await expect(promise).rejects.toThrow('timed out');
  });

  it('ignores non-EVENT relay messages (EOSE, NOTICE)', async () => {
    const promise = nwcCreateInvoice(makeConnectionString(), 10, 'desc', 80);
    await new Promise(r => setTimeout(r, 10));

    const ws = MockWebSocket.lastInstance!;
    ws.emit('message', Buffer.from(JSON.stringify(['EOSE', 'nwc-sub'])));
    ws.emit('message', Buffer.from(JSON.stringify(['NOTICE', 'rate limited'])));

    await expect(promise).rejects.toThrow('timed out');
  });
});
