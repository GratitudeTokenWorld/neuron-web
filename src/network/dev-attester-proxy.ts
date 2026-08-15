/**
 * ⚠ DEV-SERVER ONLY — MUST BE REMOVED BEFORE ANY SHIPPED BUILD, TESTNET INCLUDED.
 * (Lucian, 2026-08-15. Tracked in CLAUDE.md → *Remove before production*.)
 *
 * The problem it works around. Face capture needs a secure context, so testing
 * on a phone means the HTTPS dev tunnel (`npm run tunnel`) — there is no other
 * way in: `localhost` is not the phone, and `http://<LAN-IP>` gets no camera.
 * But the dev super-nodes are announced as raw-IP `http://…:9092`, and an HTTPS
 * page may not fetch `http://`. The browser blocks it as mixed content, the
 * attester's `/relay-info` fetch fails, the relay is dropped for want of a
 * `signingPub`, and account creation ends at "1 of 2 attesters responded" —
 * with nothing logged, because the relay is discarded before it is ever asked
 * for a challenge.
 *
 * The workaround: the Vite dev server proxies each bootstrap relay under a
 * same-origin path, so the page talks HTTPS to the tunnel and the tunnel talks
 * plain HTTP to the relay, server-side, where mixed content does not apply.
 *
 * Why it must not ship, in any build. It hard-codes dev topology into the
 * client, and it makes the app's trust in an attester depend on whatever the
 * page's own origin chooses to proxy — an attester is supposed to be an
 * INDEPENDENT party, and this routes every attestation through one server that
 * could rewrite it. That is precisely the property k-of-N attestation exists to
 * provide, so shipping this would quietly reduce 2-of-N to 1. The real fix is
 * TLS in front of the relays plus a real `faceVerifyUrl` — which production
 * needs regardless.
 *
 * Structurally dev-only: `vite.config.ts` derives these only when
 * `command === 'serve'`, so `npm run build` bakes an empty map and the client
 * lookup is inert. `dev-attester-proxy.test.ts` pins that contract.
 */

export interface DevAttesterProxy {
  /** The relay's libp2p peer id — how the client matches a candidate to a path. */
  peerId: string;
  /** Same-origin path the dev server serves this relay under. */
  path: string;
  /** Where the dev server forwards to (the relay's HTTP API). */
  target: string;
}

/**
 * Map bootstrap multiaddrs to same-origin proxy routes.
 *
 * Only raw-IP `ws` addrs are proxied: a `/dns4/…` relay already resolves to a
 * real hostname and can be served over TLS, so it needs no workaround and must
 * not get one. The relay's HTTP API is its ws port + 2 (docs/SUPERNODE.md), the
 * same derivation `relayHttpBase` uses.
 */
export function deriveDevAttesters(bootstrapAddrs: readonly string[]): DevAttesterProxy[] {
  const out: DevAttesterProxy[] = [];
  for (const addr of bootstrapAddrs) {
    const ip = addr.match(/\/ip4\/([\d.]+)\/tcp\/(\d+)\/ws(\/|$)/);
    const peer = addr.match(/\/p2p\/([A-Za-z0-9]+)/);
    if (!ip || !peer) continue;
    out.push({
      peerId: peer[1]!,
      path: `/dev-attester/${out.length}`,
      target: `http://${ip[1]}:${Number(ip[2]) + 2}`,
    });
  }
  return out;
}

/** peerId → same-origin base, the shape baked into the client. */
export function devAttesterBases(proxies: readonly DevAttesterProxy[]): Record<string, string> {
  return Object.fromEntries(proxies.map(p => [p.peerId, p.path]));
}
