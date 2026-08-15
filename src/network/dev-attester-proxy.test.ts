import { describe, it, expect } from 'vitest';
import { deriveDevAttesters, devAttesterBases } from './dev-attester-proxy.js';

/**
 * The dev attester proxy is a workaround that MUST NOT SHIP — in any build,
 * testnet included. It routes attestation through the page's own origin, and an
 * attester is supposed to be an independent party; shipping it would quietly
 * reduce k-of-N to 1.
 *
 * `vite.config.ts` only derives it when `command === 'serve'`. These tests pin
 * the derivation and, more importantly, the contract that an empty input
 * produces an empty everything — so the build path stays inert.
 */

const RELAY_A = '/ip4/80.97.27.224/tcp/9090/ws/p2p/12D3KooWQdg5zSBAJrUmxVReJ4WkhRjCw7LQudL3PosBH7R21dUh';
const RELAY_B = '/ip4/80.97.27.112/tcp/9090/ws/p2p/12D3KooWBmGKkfC9C9fGLhdCn7uSVGMcfD2urSpnULbWe7vuVymU';

describe('deriveDevAttesters', () => {
  it('routes each raw-IP relay to its own same-origin path', () => {
    const proxies = deriveDevAttesters([RELAY_A, RELAY_B]);
    expect(proxies).toEqual([
      { peerId: '12D3KooWQdg5zSBAJrUmxVReJ4WkhRjCw7LQudL3PosBH7R21dUh', path: '/dev-attester/0', target: 'http://80.97.27.224:9092' },
      { peerId: '12D3KooWBmGKkfC9C9fGLhdCn7uSVGMcfD2urSpnULbWe7vuVymU', path: '/dev-attester/1', target: 'http://80.97.27.112:9092' },
    ]);
  });

  it('derives the HTTP API as the ws port + 2, like relayHttpBase', () => {
    const [p] = deriveDevAttesters(['/ip4/10.0.0.9/tcp/4001/ws/p2p/12D3KooWTest']);
    expect(p!.target).toBe('http://10.0.0.9:4003');
  });

  it('leaves DNS relays alone — they can be served over TLS and need no workaround', () => {
    const dns = '/dns4/relay1.example.com/tcp/443/wss/p2p/12D3KooWDns';
    expect(deriveDevAttesters([dns])).toEqual([]);
    // ...and a mixed list only proxies the raw-IP one, still numbered from 0.
    const mixed = deriveDevAttesters([dns, RELAY_A]);
    expect(mixed).toHaveLength(1);
    expect(mixed[0]!.path).toBe('/dev-attester/0');
  });

  it('ignores an addr with no peer id — the client matches on peerId', () => {
    expect(deriveDevAttesters(['/ip4/1.2.3.4/tcp/9090/ws'])).toEqual([]);
  });

  it('produces nothing from nothing — the build path', () => {
    // This is the contract that keeps the workaround out of shipped bundles:
    // vite.config derives [] unless `command === 'serve'`, and [] must bake as
    // an empty map so the client-side lookup is inert.
    expect(deriveDevAttesters([])).toEqual([]);
    expect(devAttesterBases([])).toEqual({});
    expect(Object.keys(devAttesterBases(deriveDevAttesters([])))).toHaveLength(0);
  });
});

describe('devAttesterBases', () => {
  it('keys by peerId so a relay is matched however it was learned', () => {
    // Baked bootstrap and gossiped relay records carry the same peerId but can
    // carry different addr strings, so peerId is the only stable join key.
    expect(devAttesterBases(deriveDevAttesters([RELAY_A]))).toEqual({
      '12D3KooWQdg5zSBAJrUmxVReJ4WkhRjCw7LQudL3PosBH7R21dUh': '/dev-attester/0',
    });
  });
});
