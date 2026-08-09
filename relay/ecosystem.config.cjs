/**
 * pm2 process config for the super-node relay.
 *
 * Start with:  pm2 start relay/ecosystem.config.cjs   (from the repo root; then `pm2 save`)
 *
 * Per-box env (notably PEER_RELAYS, which differs on each relay) is INHERITED from
 * the shell — export it before starting, or set it in the user's profile, e.g.:
 *   export PEER_RELAYS="/dns4/<other-relay>/tcp/443/wss/http-path/relay-ws/p2p/<id>"
 *   pm2 start relay/ecosystem.config.cjs && pm2 save
 *
 * SCALING NOTE: `max_memory_restart` here is a runaway/leak BACKSTOP, not a
 * throughput cap — it does not throttle requests or connections, so it never
 * limits how large the network can grow. The archive currently lives in RAM and
 * grows with the network, so set this GENEROUSLY (≈70–80% of box RAM) via
 * RELAY_MAX_MEMORY; the real fix for memory-at-scale is moving the archive to the
 * on-disk LSM store (see docs/SUPERNODE.md → Scaling), not a tighter cap.
 */
module.exports = {
  apps: [
    {
      name: 'neuron-relay',
      script: 'npm',
      args: 'run relay',

      // Leak/runaway backstop only. Tune to your box: `RELAY_MAX_MEMORY=1500M`.
      max_memory_restart: process.env.RELAY_MAX_MEMORY || '1G',

      // Crash handling — recover from a real crash, but don't hammer in a tight
      // loop if it's failing to start. (These govern restarts, not traffic.)
      autorestart: true,
      max_restarts: 15,
      min_uptime: '30s',       // a start that survives 30s counts as healthy
      restart_delay: 2000,
      exp_backoff_restart_delay: 200,

      // Logs (rotation itself is handled by the pm2-logrotate module — see
      // docs/SUPERNODE.md → Operational hardening).
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // No `env` block on purpose: omitting it lets pm2 inherit the shell
      // environment, so each box keeps its own PEER_RELAYS / tunables.
    },
  ],
};
