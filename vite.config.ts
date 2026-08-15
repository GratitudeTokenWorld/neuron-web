import { defineConfig } from 'vite';
import { libp2pRelay } from './relay/vite-plugin';
import { deriveDevRelayProxies, devRelayBases } from './src/network/dev-relay-proxy';

/** The bootstrap relays baked into the client (see `__BOOTSTRAP_ADDRS__` below). */
const BOOTSTRAP_ADDRS = [
  ...(process.env.LOCAL_ONLY ? [] : [
    '/ip4/80.97.27.224/tcp/9090/ws/p2p/12D3KooWQdg5zSBAJrUmxVReJ4WkhRjCw7LQudL3PosBH7R21dUh',
    '/ip4/80.97.27.112/tcp/9090/ws/p2p/12D3KooWBmGKkfC9C9fGLhdCn7uSVGMcfD2urSpnULbWe7vuVymU',
  ]),
  ...(process.env.BOOTSTRAP_ADDRS || '').split(',').filter(Boolean),
];

export default defineConfig(({ command }) => {
  // ⚠ DEV SERVER ONLY — MUST NOT REACH ANY BUILD, TESTNET INCLUDED.
  // See src/network/dev-relay-proxy.ts for what this is and why it must go.
  // `command === 'serve'` is the structural guard: `npm run build` derives an
  // empty list, so the proxies do not exist and the client map bakes as {}.
  const devRelayProxies = command === 'serve' ? deriveDevRelayProxies(BOOTSTRAP_ADDRS) : [];
  if (command !== 'serve' && devRelayProxies.length > 0) {
    throw new Error('dev attester proxy must never be baked into a build — see dev-relay-proxy.ts');
  }
  const devRelayProxy = Object.fromEntries(devRelayProxies.map(a => [
    a.path,
    {
      target: a.target,
      changeOrigin: true,
      rewrite: (p: string) => p.replace(new RegExp(`^${a.path}`), '') || '/',
    },
  ]));

  return {
  root: '.',
  publicDir: 'public',
  plugins: [libp2pRelay()],
  server: {
    host: '0.0.0.0',
    allowedHosts: true,
    watch: {
      // Relay runtime state lives in .relay-data/ — never restart Vite over it.
      ignored: ['**/.relay-data/**', '**/.relay-*.json'],
    },
    proxy: {
      // Proxy relay WebSocket through Vite so the tunnel URL (port 5173/443)
      // can reach the relay (port 9090).  Mobile browsers connect to:
      //   wss://tunnel-url/relay-ws  →  Vite proxy  →  ws://localhost:9090
      '/relay-ws': {
        target: 'ws://localhost:9090',
        ws: true,
        rewrite: (path) => path.replace(/^\/relay-ws/, '') || '/',
        // Disable proxy timeouts so the WebSocket is never torn down by Vite
        // for being idle — the libp2p ping keepalive handles NAT, not Vite.
        timeout: 0,
        proxyTimeout: 0,
      },
      '/smoke-hub': {
        target: 'ws://localhost:9092',
        ws: true,
      },
      // NOTE: /log-reload is handled by a dev middleware in libp2pRelay() (not
      // proxied here) so a not-yet-started relay doesn't spam ECONNREFUSED.
      '/face-verify': {
        target: 'http://localhost:9092',
      },
      // G1 on-demand account resolution against the same-origin dev relay.
      '/resolve': {
        target: 'http://localhost:9092',
      },
      // v3 custody: recovery-share store/release + targeted key-blob store/fetch
      // against the same-origin dev relay (same pattern as /resolve).
      '/recovery-share': {
        target: 'http://localhost:9092',
      },
      '/keyblob': {
        target: 'http://localhost:9092',
      },
      // ⚠ DEV ONLY, REMOVE BEFORE PRODUCTION — same-origin routes to the raw-IP
      // dev super-nodes so the HTTPS tunnel (the only way to reach a camera on a
      // phone) can attest against more than one relay. Empty in every build.
      ...devRelayProxy,
    },
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
  },
  define: {
    'process.env': {},
    global: 'globalThis',
    // Bake bootstrap relay multiaddresses into the build.
    // Format: JSON array of multiaddr strings with /p2p/<peerId> suffix, e.g.:
    //   __BOOTSTRAP_ADDRS__: JSON.stringify([
    //     '/dns4/relay1.example.com/tcp/443/wss/http-path/relay-ws/p2p/<peerId1>',
    //     '/dns4/relay2.example.com/tcp/443/wss/http-path/relay-ws/p2p/<peerId2>',
    //   ])
    // The localStorage key 'neuronchain_bootstrap' always takes priority over this list.
    // LOCAL_ONLY=1 omits the neuronweb.org bootstrap so a local dev stack is fully
    // isolated (no production/stale state leaks in). Clients still find the local
    // relay via /relay-info.
    // Current default relays: the two cloudify.ro dev super-nodes (archive + attester
    // each — docs/CLOUD.md). Raw-IP ws/http endpoints: reachable from http://localhost
    // dev pages only (mixed content blocks them from https pages — docs/TESTPLAN.md).
    // The previous production relays (neuronweb.org, akashicrecords.dev) are replaced.
    __BOOTSTRAP_ADDRS__: JSON.stringify(BOOTSTRAP_ADDRS),
    // ⚠ DEV ONLY, REMOVE BEFORE PRODUCTION — peerId → same-origin proxy base, so
    // the client can reach a raw-IP attester from an HTTPS tunnel. `{}` in every
    // build, which makes the client-side lookup inert. See dev-relay-proxy.ts.
    __DEV_RELAY_BASES__: JSON.stringify(devRelayBases(devRelayProxies)),
    // Personhood attesters required to open an account. 1 for an isolated
    // LOCAL_ONLY dev stack (single local relay), 2 in production (two super-nodes).
    // Override with REQUIRED_ATTESTERS=<n>.
    __REQUIRED_ATTESTERS__: JSON.stringify(
      process.env.REQUIRED_ATTESTERS ? Number(process.env.REQUIRED_ATTESTERS) : (process.env.LOCAL_ONLY ? 1 : 2),
    ),
  },
  resolve: {
    alias: {
      // Node.js Buffer polyfill for libp2p dependencies
      buffer: 'buffer/',
    },
  },
  optimizeDeps: {
    include: [
      '@tensorflow/tfjs',
      '@vladmandic/face-api',
      'libp2p',
      '@libp2p/websockets',
      '@libp2p/webrtc',
      '@libp2p/circuit-relay-v2',
      '@chainsafe/libp2p-gossipsub',
      '@libp2p/kad-dht',
      '@chainsafe/libp2p-noise',
      '@libp2p/yamux',
      '@libp2p/identify',
      '@libp2p/ping',
      '@libp2p/bootstrap',
      '@sinclair/smoke',
      'idb',
      'multiformats',
      '@multiformats/multiaddr-matcher',
      '@multiformats/multiaddr',
      '@libp2p/peer-id',
      '@libp2p/utils',
      'buffer',
    ],
  },
}
});
