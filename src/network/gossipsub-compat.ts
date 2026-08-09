/**
 * gossipsub 14.x ↔ js-libp2p 3.x interop shims — REQUIRED ON EVERY NODE TYPE.
 *
 * gossipsub 14.1.2 (latest; declares no peerDependencies) predates libp2p 3.x's
 * stream API and multiaddr internals. Without these three prototype patches its
 * streams silently never form (errors are swallowed): publishes report
 * 0 recipients, `getSubscribers()` stays empty, and a node can neither forward
 * nor receive gossip. The relay has carried these fixes since federation
 * (relay/server.ts); the BROWSER build ran unpatched, which made clients able to
 * *send* through a patched relay but never *receive* from it (found 2026-08-09:
 * profile B saw no accounts; a headless observer measured `recipients: 0` /
 * `mesh: []` against both patched and bare relays, on libp2p 3.3.3 AND 3.1.7).
 *
 * Call applyGossipsubCompat() ONCE, before createLibp2p(). Safe to call twice
 * (idempotent). Remove only when gossipsub ships genuine libp2p-3.x support —
 * re-verify with a two-node publish/subscribe smoke test, not by reading
 * changelogs.
 */
import { AbstractMessageStream } from '@libp2p/utils';
import { GossipSub } from '@chainsafe/libp2p-gossipsub';

let applied = false;

export function applyGossipsubCompat(): void {
  if (applied) return;
  applied = true;

  // ── Fix A: libp2p stream API mismatch with it-pipe ──────────────────────────
  // AbstractMessageStream has Symbol.asyncIterator + send() but NOT the
  // .sink/.source duplex interface it-pipe expects. gossipsub's OutboundStream
  // calls pipe(pushable, rawStream); it-pipe's isDuplex(rawStream) check fails,
  // the TypeError is swallowed, and streamsOutbound stays empty (no messages flow).
  Object.defineProperty(AbstractMessageStream.prototype, 'source', {
    get() { return this; },
    configurable: true,
    enumerable: false,
  });
  Object.defineProperty(AbstractMessageStream.prototype, 'sink', {
    get() {
      const self = this as unknown as { send(chunk: unknown): void };
      return async (source: AsyncIterable<unknown>) => {
        for await (const chunk of source) {
          self.send(chunk);
        }
      };
    },
    configurable: true,
    enumerable: false,
  });

  // ── Fix B: multiaddr.tuples() API mismatch in GossipSub.addPeer ─────────────
  // gossipsub calls multiaddr.tuples() for IP scoring but libp2p's internal
  // multiaddr objects (different class instance) don't have this method, so
  // addPeer() throws before pushing to outboundInflightQueue — no streams form.
  // Catch and add the peer manually without IP scoring.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const proto = GossipSub.prototype as any;
  const origAddPeer = proto.addPeer;
  proto.addPeer = function (peerId: any, direction: any, addr: any) {
    try {
      return origAddPeer.call(this, peerId, direction, addr);
    } catch {
      const id = peerId.toString();
      if (!this.peers.has(id)) {
        this.peers.set(id, peerId);
        this.score?.addPeer(id);
        if (!this.outbound.has(id)) {
          this.outbound.set(id, direction === 'outbound');
        }
      }
    }
  };

  // ── Fix C: onIncomingStream handler signature mismatch ──────────────────────
  // libp2p 3.x calls protocol handlers as handler(stream, connection) with two
  // positional args; gossipsub expects handler({ stream, connection }). Without
  // this, connection.remotePeer is undefined, createInboundStream is never
  // called, and no inbound streams or mesh form — the node cannot RECEIVE.
  const origOnIncomingStream = proto.onIncomingStream;
  proto.onIncomingStream = function (streamOrObj: any, connection: any) {
    if (connection !== undefined && streamOrObj?.connection === undefined) {
      return origOnIncomingStream.call(this, { stream: streamOrObj, connection });
    }
    return origOnIncomingStream.call(this, streamOrObj);
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
