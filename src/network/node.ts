import { DAGLedger, NetworkType } from '../core/dag-ledger';
import { EngineLedger, CHALLENGE_WINDOW_MS, REQUIRED_ATTESTERS } from '../ledger/engine-ledger';
import { Libp2pNetwork } from './libp2p-network';
import { SmokeStore, GossipSubAdapter } from './smoke-store';
import { StorageManager } from './storage-manager';
import { AccountBlock } from '../core/dag-block';
import { VoteManager, Vote } from '../core/vote';
import { KeyPair, signData, verifySignature } from '../core/crypto';
import { EventEmitter } from '../core/events';
import { multiaddr } from '@multiformats/multiaddr';
import { createSnapshot, parseSnapshot, SNAPSHOT_TRIGGER_BYTES } from '../core/snapshot';
import { type Block as EngineBlock } from '../engine/core/block';
import { engineKeysFromAppPrivate } from '../ledger/key-bridge';
import { sign as engineSign, verify as engineVerify } from '../engine/core/keys';
import { castCommitteeVote, type CommitteeVote } from '../engine/consensus/finality';

/**
 * Returns a stable per-device ID persisted in localStorage.
 * Unlike libp2p's peerId, this survives page reloads so storage
 * registration correctly identifies which physical device is serving.
 */
export function getDeviceId(): string {
  try {
    let id = localStorage.getItem('neuronchain_device_id');
    if (!id) { id = crypto.randomUUID(); localStorage.setItem('neuronchain_device_id', id); }
    return id;
  } catch { return ''; }
}

const COUNTRY_CODE_KEY = 'neuronchain_country_code';
const COUNTRY_CODE_TS_KEY = 'neuronchain_country_code_ts';
const COUNTRY_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // re-check weekly

let _countryCode: string | null | undefined = undefined; // undefined = not yet resolved

/**
 * Returns the ISO 3166-1 alpha-2 country code for this device (e.g. "US", "DE").
 * Resolved once via ipapi.co (returns only the 2-letter code, IP is not stored).
 * Result is cached in localStorage for 7 days. Returns undefined on failure.
 */
export async function getCountryCode(): Promise<string | undefined> {
  if (_countryCode !== undefined) return _countryCode ?? undefined;
  try {
    const ts = parseInt(localStorage.getItem(COUNTRY_CODE_TS_KEY) ?? '0', 10);
    if (Date.now() - ts < COUNTRY_CODE_TTL_MS) {
      const cached = localStorage.getItem(COUNTRY_CODE_KEY);
      if (cached) { _countryCode = cached; return cached; }
    }
  } catch { /* ignore */ }
  try {
    const res = await fetch('https://ipapi.co/country/', { signal: AbortSignal.timeout(5_000) });
    if (res.ok) {
      const code = (await res.text()).trim().slice(0, 2).toUpperCase();
      if (/^[A-Z]{2}$/.test(code)) {
        _countryCode = code;
        try {
          localStorage.setItem(COUNTRY_CODE_KEY, code);
          localStorage.setItem(COUNTRY_CODE_TS_KEY, String(Date.now()));
        } catch { /* ignore */ }
        return code;
      }
    }
  } catch { /* network error or timeout — proceed without country */ }
  _countryCode = null;
  return undefined;
}

export interface NodeStats {
  status: 'stopped' | 'running' | 'validating';
  uptime: number;
  network: NetworkType;
  peerId: string;
  peerCount: number;
  synapses: number;
}

export class NeuronNode extends EventEmitter {
  ledger: EngineLedger;
  /** libp2p P2P network layer */
  net: Libp2pNetwork;
  /** Smoke content store (IndexedDB + HTTP-over-WebRTC) */
  store: SmokeStore;
  /** Storage deal lifecycle manager */
  storage: StorageManager;

  private status: 'stopped' | 'running' | 'validating' = 'stopped';
  private startTime: number | null = null;
  private voteProcessInterval: ReturnType<typeof setInterval> | null = null;
  private resyncInterval: ReturnType<typeof setInterval> | null = null;
  private publishInterval: ReturnType<typeof setInterval> | null = null;
  private resyncDebounce: ReturnType<typeof setTimeout> | null = null;
  private publishDebounce: ReturnType<typeof setTimeout> | null = null;
  /** P2/C3: blocks waiting for their parent to arrive, keyed by previousHash. Entries older than 5 min are evicted. */
  private pendingBlocks: Map<string, { blocks: AccountBlock[]; addedAt: number }> = new Map();
  /** Phase 1: engine blocks waiting for their parent, keyed by previousHash (same TTL/eviction). */
  private pendingEngineBlocks: Map<string, { blocks: EngineBlock[]; addedAt: number }> = new Map();
  private static readonly PENDING_BLOCK_TTL_MS = 5 * 60 * 1000;
  /** P7: accounts dirtied by incoming blocks since last resync - gate for skipping idle resync passes */
  private dirtyAccounts: Set<string> = new Set();
  /** P1: timestamp of the last publishLocalData call; used to skip already-published blocks */
  private lastPublishedAt = 0;
  /** P4: highest account _version seen in IDB at the last resync; drives incremental loadChangedAccounts */
  private lastSyncedAccountVersion = 0;
  /** A5: highest block _blockVersion seen in IDB at the last resync; drives incremental loadBlocksSince */
  private lastSyncedBlockVersion = 0;
  /** Phase 1: highest engine-block _engVersion seen at the last resync; drives loadEngineBlocksSince */
  private lastSyncedEngineBlockVersion = 0;

  localKeys: Map<string, KeyPair> = new Map();
  private processedInbox: Set<string> = new Set();
  /** A8: snapshot tracking */
  private lastSnapshotBytes = 0;
  private snapshotPending = false;
  private watchedInboxes: Set<string> = new Set();
  private static readonly MAX_INBOX = 10_000;
  private dialingPeers: Set<string> = new Set();
  private relayLivenessInterval: ReturnType<typeof setInterval> | null = null;

  constructor(network: NetworkType = 'testnet') {
    super();
    this.ledger = new EngineLedger(network, undefined, { min: REQUIRED_ATTESTERS, requiredTypes: ['personhood'] });
    this.net = new Libp2pNetwork(network);
    this.store = new SmokeStore();
    this.storage = new StorageManager(this.ledger, this.net, this.store, this.localKeys);
  }

  private eventsWired = false;

  private wireEvents(): void {
    if (this.eventsWired) return;
    this.eventsWired = true;

    this.net.on('account:synced', async (data: unknown) => {
      const acc = data as Record<string, unknown>;
      const pub = String(acc.pub);
      if (acc._sig) {
        const valid = await NeuronNode.verifyAccountData(acc);
        if (!valid) { console.warn(`[Node] Rejected account ${pub.slice(0, 12)}... - invalid signature`); return; }
      }
      // Always register - registerAccount merges into existing or creates new.
      // Dropping known accounts here was the cause of one-way sync: PC created
      // account A, received account B from mobile, but since A was already known
      // the handler returned early and B was never registered.
      this.ledger.registerAccount({
        username: String(acc.username), pub,
        balance: Number(acc.balance || 0), nonce: Number(acc.nonce || 0),
        createdAt: Number(acc.createdAt || 0), faceMapHash: String(acc.faceMapHash || ''),
        linkedAnchor: acc.linkedAnchor ? String(acc.linkedAnchor) : undefined,
        pqPub: acc.pqPub ? String(acc.pqPub) : undefined,
        pqKemPub: acc.pqKemPub ? String(acc.pqKemPub) : undefined,
        pinSalt: acc.pinSalt ? String(acc.pinSalt) : undefined,
        pinVerifier: acc.pinVerifier ? String(acc.pinVerifier) : undefined,
      });
      this.emit('account:synced', acc);
      // A new peer has data - reply with ours so the handshake completes both ways
      if (this.publishDebounce) clearTimeout(this.publishDebounce);
      this.publishDebounce = setTimeout(() => {
        this.publishDebounce = null;
        this.publishLocalData();
      }, 500);
    });

    this.net.on('block:received', async (block: unknown) => {
      await this.handleIncomingBlock(block as AccountBlock);
    });

    this.net.on('engineblock:received', async (block: unknown) => {
      await this.handleIncomingEngineBlock(block as EngineBlock);
    });

    // Phase 2: a locally-detected double-spend → gossip the evidence on the
    // equivocator's shard so all holders (and the recipients who follow it) freeze.
    this.ledger.on('account:equivocated', (ev: unknown) => {
      const e = ev as { accountId: string; a: EngineBlock; b: EngineBlock };
      try { this.net.publishEngineConflict(this.ledger.getShardOf(e.accountId), e.a, e.b); } catch { /* best-effort */ }
    });
    // Inbound double-spend evidence → verify + freeze the account (idempotent).
    this.net.on('engineconflict:received', (d: unknown) => {
      const { a, b } = d as { a: EngineBlock; b: EngineBlock };
      this.ledger.applyEvidenceFromBlocks(a, b);
    });

    // Phase 2 step 2: committee finality. When a block is added (local or foreign),
    // any local bonded validator that the VRF sorts onto that block's shard committee
    // this epoch casts + gossips a vote. Inbound votes are verified + tallied by the
    // ledger; a 2/3-seat quorum marks the block `final`.
    this.ledger.on('block:added', (b: unknown) => this.maybeCastCommitteeVotes(b as EngineBlock));
    this.net.on('enginevote:received', (v: unknown) => {
      try { this.ledger.applyCommitteeVote(v as CommitteeVote); } catch { /* malformed vote */ }
    });
    this.ledger.on('block:final', (d: unknown) => this.emit('block:final', d));

    this.net.on('vote:received', async (vote: unknown) => {
      const v = vote as Vote;
      const valid = await VoteManager.verifyVote(v);
      if (!valid) { console.warn(`[Node] Rejected vote from ${v.voterPub?.slice(0, 12)}... - invalid signature`); return; }
      this.ledger.castVote(v);
      this.emit('vote:received', v);
    });

    this.ledger.on('block:added',      (b: unknown) => this.emit('block:added', b));
    this.ledger.on('block:confirmed',  (b: unknown) => this.emit('block:confirmed', b));
    this.ledger.on('block:conflict',   (b: unknown) => this.emit('block:conflict', b));
    this.ledger.on('block:rejected',   (b: unknown) => this.emit('block:rejected', b));
    this.ledger.on('contract:deployed',(d: unknown) => this.emit('contract:deployed', d));
    this.ledger.on('contract:executed',(d: unknown) => this.emit('contract:executed', d));
    this.ledger.on('contract:error',   (d: unknown) => this.emit('contract:error', d));

    // G4: persist contract state to IDB whenever it changes
    this.ledger.on('contract:state-changed', async (d: unknown) => {
      const { contractId, state } = d as { contractId: string; state: Record<string, unknown> };
      const contract = this.ledger.contracts.get(contractId);
      if (contract) {
        await this.net.saveContract(contractId, { owner: contract.owner, code: contract.code, name: contract.name, deployedAt: contract.deployedAt, state });
      }
    });

    this.net.on('peer:addrs', async (data: unknown) => {
      const { peerId, addrs, smokeAddr } = data as { peerId: string; addrs: string[]; smokeAddr?: string };
      await this.dialPeer(peerId, addrs);
      // Register every peer's smoke Hub address so retrieve() can fetch from any peer
      if (smokeAddr) this.store.addPeerFallback(smokeAddr);
    });

    this.net.on('peer:connected', (id: unknown) => {
      this.emit('peer:connected', id);
      // Re-broadcast all local accounts and blocks so the newly connected
      // peer can sync state. Debounced so rapid multi-peer connections only
      // trigger one publish. 2s delay lets the GossipSub mesh form first.
      if (this.publishDebounce) clearTimeout(this.publishDebounce);
      this.publishDebounce = setTimeout(() => {
        this.publishDebounce = null;
        this.publishLocalData();
      }, 2000);
    });
    this.net.on('peer:disconnected', (id: unknown) => this.emit('peer:disconnected', id));

    // A8: apply a gossipped snapshot if the ledger is empty (bootstrap path)
    this.net.on('snapshot:announced', async (info: unknown) => {
      const { cid } = info as { cid: string; sizeBytes: number; epochBlock: string };
      if (this.ledger.allBlocks.size > 0) return;
      try {
        const data = await this.store.retrieve(cid, 60_000);
        if (data) await this.applySnapshot(data);
      } catch { /* snapshot unavailable - normal sync will follow */ }
    });

    this.net.on('generation:changed', (isReset: unknown) => {
      if (isReset) {
        // Real testnet reset from another device - wipe in-memory state and reload
        this.ledger.reset();
        this.localKeys.clear();
        this.processedInbox.clear();
        this.emit('generation:reset'); // → main.ts → location.reload()
      } else {
        // Sync-only generation update (publishLocalData re-broadcast).
        // IDB was NOT cleared, so in-memory state is still valid.
        // Re-publish immediately so our messages pass peers' _gen filter.
        setTimeout(() => this.publishLocalData(), 1000);
      }
    });

    this.storage.on('storage:heartbeat-sent', (d: unknown) => this.emit('storage:heartbeat-sent', d));
    this.storage.on('storage:reward-issued',  (d: unknown) => this.emit('storage:reward-issued', d));
    this.storage.on('storage:cached',          (d: unknown) => this.emit('storage:cached', d));

    for (const pub of this.localKeys.keys()) {
      this.startInboxWatch(pub);
      this.net.subscribeEngineShard(this.ledger.getShardOf(pub)); // Slice 3: hold our own accounts' shards
    }
  }

  private async dialPeer(peerId: string, addrs: string[]): Promise<void> {
    if (!this.net.libp2p) return;
    const connected = this.net.libp2p.getConnections().some(c => c.remotePeer.toString() === peerId);
    if (connected) return;
    if (this.dialingPeers.has(peerId)) return;
    this.dialingPeers.add(peerId);
    try {

    // Build simplified circuit-relay addrs from our own existing relay connections.
    // The received addrs may contain transport-specific components like
    // wss/http-path/relay-ws that confuse the circuit-relay transport's dialFilter
    // on some libp2p/multiaddr version combinations, causing "Can't interpret
    // protocol p2p-circuit". The simplified /p2p/{relay}/p2p-circuit format has
    // no such components and the transport reuses the already-open relay connection.
    const constructed: string[] = [];
    for (const conn of this.net.libp2p.getConnections()) {
      const relayId = conn.remotePeer.toString();
      if (relayId !== peerId) {
        constructed.push(`/p2p/${relayId}/p2p-circuit/p2p/${peerId}`);
      }
    }

    const toTry = [...constructed, ...addrs];
    for (const addrStr of toTry) {
      try {
        await this.net.libp2p.dial(multiaddr(addrStr));
        return;
      } catch { /* try next addr */ }
    }
    } finally {
      this.dialingPeers.delete(peerId);
    }
  }

  async connectToKnownPeers(): Promise<void> {
    const known = [...this.net.knownPeerAddrs.entries()];
    const myAddrs = (this.net.libp2p?.getMultiaddrs?.() ?? []).map(a => a.toString());
    const conns = (this.net.libp2p?.getConnections?.() ?? []).map(c => c.remotePeer.toString());
    for (const [peerId, entry] of known) {
      await this.dialPeer(peerId, entry.addrs);
    }
  }

  /** P2: attempt to add a block and retry any queued children on success */
  private async handleIncomingBlock(b: AccountBlock): Promise<void> {
    if (b.type === 'open' && !this.ledger.accounts.has(b.accountPub)) {
      this.ledger.registerAccount({ username: b.accountPub, pub: b.accountPub, balance: 0, nonce: 0, createdAt: b.timestamp, faceMapHash: b.faceMapHash || '' });
    }
    const result = await this.ledger.addBlock(b);
    if (result.success) {
      this.emit('block:received', b);
      this.voteIfConflict(b);
      this.autoReceive(b);
      // Flush any children that were waiting for this block as their parent
      const entry = this.pendingBlocks.get(b.hash);
      if (entry) {
        this.pendingBlocks.delete(b.hash);
        for (const child of entry.blocks) await this.handleIncomingBlock(child);
      }
      // P7: mark account as dirty so resyncFromNet knows something changed
      this.dirtyAccounts.add(b.accountPub);
    } else if (result.error === 'previousHash mismatch') {
      // Parent not yet received - queue the block and clear it from gossip dedup
      // so it can be retried if re-broadcast, OR when the parent arrives above.
      this.net.forgetBlock(b.hash);
      // C3: evict stale pending entries before adding
      const now = Date.now();
      for (const [k, v] of this.pendingBlocks) {
        if (now - v.addedAt > NeuronNode.PENDING_BLOCK_TTL_MS) this.pendingBlocks.delete(k);
      }
      const existing = this.pendingBlocks.get(b.previousHash);
      if (existing) {
        existing.blocks.push(b);
      } else {
        this.pendingBlocks.set(b.previousHash, { blocks: [b], addedAt: now });
      }
    } else {
      // Allow the re-broadcast cycle to retry other transient failures.
      this.net.forgetBlock(b.hash);
    }
  }

  /** G6 + S8: vote to approve the earliest block in a conflict; reject locked accounts; abstain when chain context is missing */
  private async voteIfConflict(block: AccountBlock): Promise<void> {
    if (this.ledger.votes.getStatus(block.hash) !== 'conflict') return;

    // G6: if the block's parent is not in our ledger, we cannot make an informed
    // approve/reject decision. Send an abstain vote so finalization knows we
    // participated but lack context - this prevents uninformed votes from biasing
    // the outcome and pushes conflicts toward the timestamp-ordered timeout path.
    const hasParentContext = block.index === 0 || this.ledger.allBlocks.has(block.previousHash);
    if (!hasParentContext) {
      for (const [pub, keys] of this.localKeys) {
        const balance = this.ledger.getAccountBalance(pub);
        if (balance <= 0) continue;
        const head = this.ledger.getAccountHead(pub);
        const vote = await VoteManager.createVote(block.hash, false, balance, keys, head?.hash, true);
        this.ledger.castVote(vote);
        this.net.publishVote(vote);
      }
      return;
    }

    // S8: blocks from locked accounts are always rejected in conflict resolution
    const isLocked = this.net.isLockedOut(block.accountPub);
    // G6: prefer the block with the smallest timestamp; break ties by hash
    const siblings = this.ledger.votes.getSiblings(block.hash);
    let approve = !isLocked;
    if (approve) {
      for (const sibHash of siblings) {
        const sib = this.ledger.allBlocks.get(sibHash);
        if (!sib) continue;
        if (sib.timestamp < block.timestamp || (sib.timestamp === block.timestamp && sibHash < block.hash)) {
          approve = false;
          break;
        }
      }
    }
    for (const [pub, keys] of this.localKeys) {
      const balance = this.ledger.getAccountBalance(pub);
      if (balance <= 0) continue;
      const head = this.ledger.getAccountHead(pub);
      const vote = await VoteManager.createVote(block.hash, approve, balance, keys, head?.hash);
      this.ledger.castVote(vote);
      this.net.publishVote(vote);
    }
  }

  private async autoReceive(block: AccountBlock): Promise<void> {
    if (block.type !== 'send' || !block.recipient) return;
    const keys = this.localKeys.get(block.recipient);
    if (!keys) return;
    setTimeout(async () => {
      const result = await this.ledger.createReceive(block.recipient!, block.hash, keys);
      if (result.block) {
        await this.ledger.addBlock(result.block);
        this.net.publishBlock(result.block);
        this.emit('auto:received', { from: block.accountPub, amount: block.amount });
      }
    }, 500);
  }

  // ── Engine-block ingest (Phase 1 multi-node sync) ─────────────────────────
  // Parallel to the legacy AccountBlock path above; engine blocks never route
  // through voteIfConflict/serializeBlock. addBlock is synchronous.

  private async handleIncomingEngineBlock(block: EngineBlock): Promise<void> {
    const result = this.ledger.addBlock(block);
    if (result.success) {
      this.dirtyAccounts.add(block.accountId);
      this.emit('engineblock:received', block);
      await this.autoReceiveEngine(block);
      // Flush any children that were waiting for this block as their parent.
      const entry = this.pendingEngineBlocks.get(block.hash);
      if (entry) {
        this.pendingEngineBlocks.delete(block.hash);
        for (const child of entry.blocks) await this.handleIncomingEngineBlock(child);
      }
    } else if (result.error === 'missing prior chain' || result.error === 'non-sequential') {
      // Parent (or an intermediate block) not yet applied. Queue under previousHash
      // and clear gossip dedup so it retries when the parent arrives / re-broadcasts.
      this.net.forgetEngineBlock(block.hash);
      const now = Date.now();
      for (const [k, v] of this.pendingEngineBlocks) {
        if (now - v.addedAt > NeuronNode.PENDING_BLOCK_TTL_MS) this.pendingEngineBlocks.delete(k);
      }
      const existing = this.pendingEngineBlocks.get(block.previousHash);
      if (existing) existing.blocks.push(block);
      else this.pendingEngineBlocks.set(block.previousHash, { blocks: [block], addedAt: now });
    } else {
      // bad hash/sig/genesis/conflict — allow re-broadcast retry, otherwise drop.
      this.net.forgetEngineBlock(block.hash);
    }
  }

  private async autoReceiveEngine(block: EngineBlock): Promise<void> {
    if (block.type !== 'send' && block.type !== 'nft-send') return;
    if (!block.recipient) return;
    const appKeys = this.localKeys.get(block.recipient); // localKeys is keyed by engine accountId
    if (!appKeys) return; // not addressed to a local account
    const signer = engineKeysFromAppPrivate(appKeys.priv);
    const isNft = block.type === 'nft-send';
    // Recipient-witnessed finality: wait the challenge window, then claim ONLY if
    // the sender hasn't been proven to double-spend in the meantime. NFTs claim the
    // same way payments do (block-lattice send → receive).
    setTimeout(async () => {
      if (this.ledger.isEquivocated(block.accountId)) return; // sender double-spent → don't honor
      const result = isNft
        ? await this.ledger.createReceiveNft(block.recipient!, block.hash, signer)
        : await this.ledger.createReceive(block.recipient!, block.hash, signer);
      if (result.block) {
        this.ledger.addBlock(result.block);
        this.net.publishEngineBlock(result.block);
        if (isNft) this.emit('nft:received', { from: block.accountId, tokenId: block.tokenId });
        else this.emit('auto:received', { from: block.accountId, amount: Number(block.amount ?? 0) });
      }
    }, CHALLENGE_WINDOW_MS);
  }

  /**
   * Phase 2 step 2: for each local bonded validator, run VRF self-sortition for
   * `block`'s shard this epoch; if it wins any committee seats, cast a signed vote,
   * count it locally, and gossip it on the shard's vote topic. A non-validator (the
   * common case) does nothing — zero common-path cost. Per-shard ⇒ O(committee).
   */
  private maybeCastCommitteeVotes(block: EngineBlock): void {
    if (block.shard === undefined) return;
    const seed = this.ledger.currentSeed();
    if (!seed) return;
    const epoch = this.ledger.currentEpoch;
    const total = this.ledger.totalValidatorWeight();
    const committeeSize = this.ledger.committeeSize;
    for (const [pub, keys] of this.localKeys) {
      if (!this.ledger.isValidator(pub)) continue;
      let vote: CommitteeVote | null;
      try {
        const enginePriv = engineKeysFromAppPrivate(keys.priv).priv;
        vote = castCommitteeVote(
          enginePriv, pub, { hash: block.hash, shard: block.shard },
          seed, epoch, this.ledger.validatorWeight(pub), total, committeeSize,
        );
      } catch { continue; }
      if (!vote) continue; // not sorted onto this committee this epoch
      this.ledger.applyCommitteeVote(vote); // count our own vote
      try { this.net.publishEngineVote(vote); } catch { /* best-effort */ }
    }
  }

  // Sweep ledger.unclaimedSends for any sends addressed to local keys and
  // auto-receive them. This is the fallback path for missed auto-receives.
  //
  // Why this is needed:
  //   autoReceive() fires from the block:received event, which is only emitted
  //   once per block hash (processedBlocks dedup prevents re-emission on
  //   gossipsub re-broadcasts). If the recipient's node missed that single
  //   delivery window - e.g. the gossipsub mesh hadn't fully formed yet when
  //   the sender first published the block - the receive is never created and
  //   no amount of re-broadcasting will fix it via the event path.
  //
  //   sweepUnclaimedReceives() bypasses gossipsub entirely and works directly
  //   off ledger.unclaimedSends, which is populated whenever a send block is
  //   successfully added to the ledger (regardless of how it arrived).
  //
  // Called: 4s after node start, every 20s alongside publishLocalData(),
  //         and 1s after addLocalKey() (covers sends that arrived before
  //         the user recovered their keys).
  private async sweepUnclaimedReceives(): Promise<void> {
    for (const [pub, keys] of this.localKeys) {
      const signer = engineKeysFromAppPrivate(keys.priv); // localKeys holds app keys; the engine needs engine keys
      // Payments
      for (const { sendBlockHash, fromPub, amount } of this.ledger.getUnclaimedForAccount(pub)) {
        const result = await this.ledger.createReceive(pub, sendBlockHash, signer);
        if (result.block) {
          this.ledger.addBlock(result.block);
          this.net.publishEngineBlock(result.block);
          this.emit('auto:received', { from: fromPub, amount });
        }
      }
      // NFTs — same fallback (needed for same-node transfers: a node doesn't get
      // its own gossip, so the recipient's auto-receive never fires off the wire).
      for (const { nftSendHash, fromPub, tokenId } of this.ledger.getUnclaimedNftsForAccount(pub)) {
        const result = await this.ledger.createReceiveNft(pub, nftSendHash, signer);
        if (result.block) {
          this.ledger.addBlock(result.block);
          this.net.publishEngineBlock(result.block);
          this.emit('nft:received', { from: fromPub, tokenId });
        }
      }
    }
  }

  private startInboxWatch(pub: string): void {
    if (this.watchedInboxes.has(pub)) return;
    this.watchedInboxes.add(pub);
    this.net.watchInbox(pub, async (signal) => {
      const key = `${signal.blockHash}:${signal.sender}`;
      if (this.processedInbox.has(key)) return;
      if (signal.signature) {
        // Engine identity: the sender signs with its engine key over accountId.
        const payload = `inbox:${signal.blockHash}:${signal.sender}:${pub}:${signal.amount}`;
        if (!engineVerify(signal.signature, payload, signal.sender)) { console.warn(`[Inbox] Rejected signal - invalid signature`); return; }
      }
      this.processedInbox.add(key);
      if (this.processedInbox.size > NeuronNode.MAX_INBOX) {
        const first = this.processedInbox.values().next().value!;
        this.processedInbox.delete(first);
      }
      this.emit('inbox:signal', signal);
      // Slice 2: pull the sender's chain tail so the send block (and our
      // auto-receive) arrive even if we don't hold the sender's shard.
      if (!this.ledger.allBlocks.has(signal.blockHash)) this.engineResyncAccount(signal.sender);
    });
  }

  private async resyncAccount(accountPub: string): Promise<void> {
    try {
      if (!this.ledger.accounts.has(accountPub)) {
        const accData = await this.net.loadAccount(accountPub);
        if (accData?.username) {
          if (accData._sig) {
            const valid = await NeuronNode.verifyAccountData(accData);
            if (!valid) { console.warn(`[Resync] Rejected account - invalid signature`); return; }
          }
          this.ledger.registerAccount({
            username: String(accData.username), pub: String(accData.pub || accountPub),
            balance: Number(accData.balance || 0), nonce: Number(accData.nonce || 0),
            createdAt: Number(accData.createdAt || 0), faceMapHash: String(accData.faceMapHash || ''),
            linkedAnchor: accData.linkedAnchor ? String(accData.linkedAnchor) : undefined,
            pqPub: accData.pqPub ? String(accData.pqPub) : undefined,
            pqKemPub: accData.pqKemPub ? String(accData.pqKemPub) : undefined,
            pinSalt: accData.pinSalt ? String(accData.pinSalt) : undefined,
            pinVerifier: accData.pinVerifier ? String(accData.pinVerifier) : undefined,
          });
        }
      }
      const blocks = await this.net.loadAccountChain(accountPub);
      let newBlocks = 0;
      for (const block of blocks) {
        if (!this.ledger.allBlocks.has(block.hash)) {
          const result = await this.ledger.addBlock(block);
          if (result.success) { newBlocks++; this.voteIfConflict(block); this.autoReceive(block); }
        }
      }
      if (newBlocks > 0) { this.emit('resync', { newAccounts: 0, newBlocks }); }
    } catch (err) { console.error('[Resync] error:', err); }
  }

  /**
   * Slice 2: pull an engine account's chain tail from peers. The missing blocks
   * arrive on the engine-blocks topic → handleIncomingEngineBlock (apply +
   * autoReceiveEngine), so this just fires the request. This is how a recipient
   * obtains a send it didn't receive via gossip (e.g. once subscription is
   * shard-scoped in Slice 3, or after a fresh-device recovery).
   */
  private engineResyncAccount(accountId: string): void {
    const shard = this.ledger.getShardOf(accountId);
    // Verbose; enable in the browser console with localStorage.neuron_debug = '1'.
    try { if (localStorage.getItem('neuron_debug') === '1') console.log(`[engine] pull acct=${accountId.slice(0, 12)}… shard=${shard} have=${this.ledger.getAccountHead(accountId)?.index ?? -1}`); } catch { /* no localStorage */ }
    // Follow-on-demand: subscribe to the target shard so the holder's re-broadcast
    // (delta response, and the 20s periodic re-broadcast backstop) reaches us.
    this.net.subscribeEngineShard(shard);
    const haveIndex = this.ledger.getAccountHead(accountId)?.index ?? -1;
    this.net.requestEngineDelta(accountId, haveIndex, shard);
    // Retry once after the gossipsub mesh for the freshly-subscribed shard forms.
    setTimeout(() => {
      const idx = this.ledger.getAccountHead(accountId)?.index ?? -1;
      this.net.requestEngineDelta(accountId, idx, shard);
    }, 1500);
  }

  addLocalKey(pub: string, keys: KeyPair): void {
    this.localKeys.set(pub, keys);
    this.net.subscribeEngineShard(this.ledger.getShardOf(pub)); // Slice 3: hold this account's shard (queues if not running)
    if (this.status !== 'stopped') {
      this.startInboxWatch(pub);
      setTimeout(() => this.sweepUnclaimedReceives(), 1000);
      // Slice 4c: an account added after start (recovery, new device) must pull its
      // own chain — the start() bootstrap only covers accounts present at startup.
      setTimeout(() => this.engineResyncAccount(pub), 1500);
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.status !== 'stopped') return;
    await this.net.start();

    // Build a GossipSubAdapter so WebRTC ICE signaling routes through the existing
    // GossipSub mesh instead of the relay WebSocket, removing the hub as a SPOF.
    const pubsub = this.net.libp2p.services.pubsub as unknown as {
      publish(topic: string, data: Uint8Array): Promise<void>;
      subscribe(topic: string): void;
      addEventListener(event: string, handler: EventListener): void;
      removeEventListener(event: string, handler: EventListener): void;
    };
    const gsAdapter: GossipSubAdapter = {
      peerId: this.net.libp2p.peerId.toString(),
      networkId: this.ledger.network,
      publish: (topic, data) => { pubsub.publish(topic, data).catch(() => {}); },
      subscribe: (topic) => pubsub.subscribe(topic),
      addEventListener: (evt, cb) => pubsub.addEventListener(evt, cb),
      removeEventListener: (evt, cb) => pubsub.removeEventListener(evt, cb),
    };

    await this.store.start(gsAdapter);
    // Push our smoke address (now the libp2p peer ID) into peer-addrs broadcasts
    // so every peer can reach us for content retrieval.
    this.store.getSmokeHostname().then(addr => { if (addr) this.net.setSmokeAddr(addr); });
    await this.storage.start();
    this.wireEvents();

    const [chains, accounts, contracts] = await Promise.all([
      this.net.loadAccountChains(),
      this.net.loadAccounts(),
      this.net.loadContracts(),
    ]);

    for (const [pub, accData] of accounts) {
      this.ledger.registerAccount({
        username: String(accData.username || ''), pub: String(accData.pub || pub),
        balance: Number(accData.balance || 0), nonce: Number(accData.nonce || 0),
        createdAt: Number(accData.createdAt || 0), faceMapHash: String(accData.faceMapHash || ''),
        linkedAnchor: accData.linkedAnchor ? String(accData.linkedAnchor) : undefined,
        pqPub: accData.pqPub ? String(accData.pqPub) : undefined,
        pqKemPub: accData.pqKemPub ? String(accData.pqKemPub) : undefined,
        pinSalt: accData.pinSalt ? String(accData.pinSalt) : undefined,
        pinVerifier: accData.pinVerifier ? String(accData.pinVerifier) : undefined,
      });
    }

    for (const [, chain] of chains) {
      for (const block of chain) await this.ledger.addBlock(block);
    }
    // Phase 1: replay persisted engine blocks (sorted open→dependent) so received
    // cross-node state survives reload. Idempotent vs main.ts's per-wallet open replay.
    for (const block of await this.net.loadAllEngineBlocks()) this.ledger.addBlock(block);
    // A7: faceAccountCount is maintained incrementally by addBlock - no rebuild needed
    // Sync heartbeat counts to the current rolling window (uses Date.now() as reference).
    this.ledger.refreshHeartbeatCounts();

    // Seed peer fallbacks from heartbeat-recorded smoke addresses. Providers that have
    // been online recently will have their current (or last known) smoke address on-chain.
    for (const provider of this.ledger.getStorageProviders()) {
      if (provider.smokeAddr) this.store.addPeerFallback(provider.smokeAddr);
    }

    for (const [id, cData] of contracts) {
      if (!this.ledger.contracts.has(id)) {
        this.ledger.contracts.set(id, {
          owner: String(cData.owner || ''), code: String(cData.code || ''),
          state: {}, name: String(cData.name || ''), deployedAt: Number(cData.deployedAt || 0),
        });
      }
    }

    // P4/A5: record watermarks after startup load so resyncFromNet only reads new writes
    this.lastSyncedAccountVersion = this.net.getAccountVersionCounter();
    this.lastSyncedBlockVersion = this.net.getBlockVersionCounter();
    this.lastSyncedEngineBlockVersion = this.net.getEngineBlockVersionCounter();

    this.voteProcessInterval = setInterval(() => this.ledger.processConflicts(), 3000);
    this.resyncInterval = setInterval(() => this.resyncFromNet(), 60_000);
    this.relayLivenessInterval = setInterval(() => this.checkRelayLiveness(), 5 * 60 * 1000);
    // Re-publish every 20s: incremental (new blocks only) to avoid flooding the mesh
    this.publishInterval = setInterval(() => {
      this.publishLocalData(false);
      this.sweepUnclaimedReceives();
      this.maybeCreateSnapshot().catch(console.error);
    }, 20_000);

    // Publish local state once on startup so any already-connected peers receive it
    setTimeout(() => this.publishLocalData(), 3000);
    // Sweep for any unclaimed sends that arrived before keys were loaded
    setTimeout(() => this.sweepUnclaimedReceives(), 4000);
    // P7: dial known peers that were discovered in previous sessions
    setTimeout(() => this.connectToKnownPeers(), 5000);
    // Slice 4c: bootstrap — pull our own accounts' chains from holders (the
    // super-node archive serves them), so a fresh/recovered device restores its
    // balance without waiting for a periodic re-broadcast. Delayed so relay/peer
    // connections + shard meshes form first.
    setTimeout(() => { for (const pub of this.localKeys.keys()) this.engineResyncAccount(pub); }, 6000);
    // ALSO refresh every held FOREIGN chain (counterparties we verified before).
    // A send made while this node was OFFLINE lives on the sender's chain; inbox
    // gossip is not replayed, so without this pull the new send block never
    // arrives and the unclaimed-receive sweep has nothing to claim (the
    // "offline recipient misses transfers" bug, found in TESTPLAN T3). Cost is
    // O(held accounts) = own + counterparties — scale-invariant-safe. Arriving
    // blocks flow through handleIncomingEngineBlock → autoReceiveEngine, which
    // claims pending sends automatically.
    setTimeout(() => {
      const own = new Set(this.localKeys.keys());
      const held = new Set<string>();
      for (const b of this.ledger.allBlocks.values()) if (!own.has(b.accountId)) held.add(b.accountId);
      for (const id of held) this.engineResyncAccount(id);
    }, 7500);

    this.status = 'running';
    this.startTime = Date.now();
    this.emit('node:started');
  }

  private async resyncFromNet(): Promise<void> {
    // P7: skip IDB resync if no network activity has dirtied any accounts since last run
    if (this.dirtyAccounts.size === 0) return;
    this.dirtyAccounts.clear();
    try {
      // P4: only read accounts written to IDB after the last resync (O(changed) vs O(total))
      const accounts = await this.net.loadChangedAccounts(this.lastSyncedAccountVersion);
      let newAccounts = 0;
      for (const [pub, accData] of accounts) {
        if (!accData.username) continue;
        if (accData._sig) {
          const valid = await NeuronNode.verifyAccountData(accData);
          if (!valid) continue;
        }
        const existing = this.ledger.accounts.has(pub);
        this.ledger.registerAccount({
          username: String(accData.username), pub: String(accData.pub || pub),
          balance: Number(accData.balance || 0), nonce: Number(accData.nonce || 0),
          createdAt: Number(accData.createdAt || 0), faceMapHash: String(accData.faceMapHash || ''),
          linkedAnchor: accData.linkedAnchor ? String(accData.linkedAnchor) : undefined,
          pqPub: accData.pqPub ? String(accData.pqPub) : undefined,
          pqKemPub: accData.pqKemPub ? String(accData.pqKemPub) : undefined,
          pinSalt: accData.pinSalt ? String(accData.pinSalt) : undefined,
          pinVerifier: accData.pinVerifier ? String(accData.pinVerifier) : undefined,
        });
        if (!existing) newAccounts++;
      }

      // A5: only read blocks written to IDB after the last resync - O(new) instead of O(all)
      const newBlockList = await this.net.loadBlocksSince(this.lastSyncedBlockVersion);
      let newBlocks = 0;
      for (const block of newBlockList) {
        if (!this.ledger.accounts.has(block.accountPub)) {
          this.ledger.registerAccount({ username: block.accountPub.slice(0, 16), pub: block.accountPub, balance: 0, nonce: 0, createdAt: Date.now(), faceMapHash: '' });
        }
        if (!this.ledger.allBlocks.has(block.hash)) {
          const result = await this.ledger.addBlock(block);
          if (result.success) { newBlocks++; this.voteIfConflict(block); this.autoReceive(block); }
        }
      }
      // Phase 1: apply engine blocks persisted since the last resync (safety net
      // for gossip the live mesh missed). Orphans are handled inside the handler.
      for (const block of await this.net.loadEngineBlocksSince(this.lastSyncedEngineBlockVersion)) {
        if (!this.ledger.allBlocks.has(block.hash)) await this.handleIncomingEngineBlock(block);
      }

      // P4/A5: advance watermarks so the next resync only reads newer writes
      this.lastSyncedAccountVersion = this.net.getAccountVersionCounter();
      this.lastSyncedBlockVersion = this.net.getBlockVersionCounter();
      this.lastSyncedEngineBlockVersion = this.net.getEngineBlockVersionCounter();

      // A7: faceAccountCount is maintained incrementally in addBlock - no rebuild needed
      if (newAccounts > 0 || newBlocks > 0) {
        this.emit('resync', { newAccounts, newBlocks });
      }
    } catch (err) { console.error('[Resync] error:', err); }
  }

  requestResync(): void {
    if (this.status === 'stopped') return;
    if (this.resyncDebounce) clearTimeout(this.resyncDebounce);
    this.resyncDebounce = setTimeout(() => { this.resyncDebounce = null; this.resyncFromNet(); }, 500);
  }

  // Account records are identified by the engine accountId (acc.pub = compressed-hex
  // engine pubkey), so they MUST be signed/verified with the engine keys over that
  // identity — not the app JWK (signData/verifySignature verify against the JWK pub,
  // which diverged from accountId in the engine migration, so cross-node verification
  // silently failed and dropped every remote account record → usernames showed as hex).
  private async signAccountData(acc: Record<string, unknown>, keys: KeyPair): Promise<Record<string, unknown>> {
    const payload = `account:${acc.pub}:${acc.username}:${acc.createdAt}:${acc.faceMapHash}`;
    const signer = engineKeysFromAppPrivate(keys.priv);
    return { ...acc, _sig: engineSign(payload, signer.priv) };
  }

  private static verifyAccountData(acc: Record<string, unknown>): boolean {
    if (!acc._sig || !acc.pub) return false;
    const payload = `account:${acc.pub}:${acc.username}:${acc.createdAt}:${acc.faceMapHash}`;
    return engineVerify(String(acc._sig), payload, String(acc.pub));
  }

  /**
   * Broadcast local state to peers.
   * full=true  → send all blocks (used on peer:connected and startup)
   * full=false → send only blocks with timestamp >= lastPublishedAt (periodic 20s tick)
   *
   * Accounts are always re-published (small overhead, needed for peer discovery).
   * Key blobs are NOT re-gossiped here - they are published once on save via saveKeyBlob.
   */
  async publishLocalData(full = true): Promise<void> {
    this.net.publishGeneration();

    for (const [pub, acc] of this.ledger.accounts) {
      const keys = this.localKeys.get(pub);
      // FOREIGN account: echo the newest record we actually received instead of
      // rebuilding it from our ledger copy. registerAccount() never updates a
      // known account, so that copy is frozen at first sight — re-publishing it
      // would revert the owner's key/PIN rotations for the whole network (the
      // stale-anchor bug). IDB always holds the latest record we were told about.
      if (!keys) {
        const stored = await this.net.loadAccount(pub);
        if (stored) this.net.saveAccount(pub, stored as Parameters<typeof this.net.saveAccount>[1]);
        continue;
      }
      const accData: Record<string, unknown> = {
        username: acc.username, pub: acc.pub, balance: acc.balance, nonce: acc.nonce,
        createdAt: acc.createdAt, faceMapHash: acc.faceMapHash,
        linkedAnchor: acc.linkedAnchor ?? undefined,
        pqPub: acc.pqPub ?? undefined,
        pqKemPub: acc.pqKemPub ?? undefined,
        pinSalt: acc.pinSalt ?? undefined,
        pinVerifier: acc.pinVerifier ?? undefined,
      };
      this.net.saveAccount(pub, await this.signAccountData(accData, keys));
    }

    // Phase 1: re-broadcast engine blocks (hex-encoded). Receivers dedup on hash,
    // so re-publishing the full set is safe; per-node cost is bounded by the
    // accounts a node actually holds (own + followed). Slice 3 makes this per-shard.
    for (const block of this.ledger.allBlocks.values()) {
      this.net.publishEngineBlock(block);
    }
    this.lastPublishedAt = Date.now();
  }

  async stop(): Promise<void> {
    this.stopValidating();
    if (this.voteProcessInterval) { clearInterval(this.voteProcessInterval); this.voteProcessInterval = null; }
    if (this.resyncInterval) { clearInterval(this.resyncInterval); this.resyncInterval = null; }
    if (this.publishInterval) { clearInterval(this.publishInterval); this.publishInterval = null; }
    if (this.relayLivenessInterval) { clearInterval(this.relayLivenessInterval); this.relayLivenessInterval = null; }
    if (this.resyncDebounce) { clearTimeout(this.resyncDebounce); this.resyncDebounce = null; }
    if (this.publishDebounce) { clearTimeout(this.publishDebounce); this.publishDebounce = null; }
    this.storage.stop();
    await this.store.stop();
    await this.net.stop();
    this.net.removeAllListeners();
    this.ledger.removeAllListeners();
    this.eventsWired = false;
    this.processedInbox.clear();
    this.watchedInboxes.clear();
    this.status = 'stopped';
    this.startTime = null;
    this.emit('node:stopped');
  }

  startValidating(): void {
    if (this.status === 'stopped') return;
    this.status = 'validating';
    this.emit('validating:started');
  }

  stopValidating(): void {
    if (this.status === 'validating') { this.status = 'running'; this.emit('validating:stopped'); }
  }

  // ── A8: Epoch snapshots ───────────────────────────────────────────────────

  /**
   * If the estimated blockchain size has grown by >= 1 GB since the last snapshot,
   * create a compressed snapshot, pin it in the SmokeStore, and broadcast the CID
   * to the gossip network so new nodes can bootstrap from it.
   */
  async maybeCreateSnapshot(): Promise<void> {
    if (this.snapshotPending) return;
    const currentBytes = this.ledger.estimateBlockchainSizeBytes();
    if (currentBytes - this.lastSnapshotBytes < SNAPSHOT_TRIGGER_BYTES) return;

    this.snapshotPending = true;
    try {
      const accounts = Array.from(this.ledger.accounts.values());
      const blocks = Array.from(this.ledger.allBlocks.values());
      const head = blocks.reduce((best, b) => (!best || b.timestamp > best.timestamp) ? b : best, blocks[0] as AccountBlock | undefined);
      const epochBlock = head?.hash ?? '0'.repeat(64);

      const data = await createSnapshot(this.ledger.network, accounts, blocks, epochBlock);
      const cid = await this.store.store(data);

      this.net.publishSnapshot(cid, data.byteLength, epochBlock);
      this.lastSnapshotBytes = currentBytes;
      this.emit('snapshot:created', { cid, bytes: data.byteLength });
    } catch (err) {
      console.error('[Snapshot] creation failed:', err);
    } finally {
      this.snapshotPending = false;
    }
  }

  /**
   * Apply an incoming snapshot to the ledger. Only applied if the ledger is empty
   * (bootstrap case) to avoid overwriting existing state.
   */
  async applySnapshot(data: Uint8Array): Promise<boolean> {
    if (this.ledger.allBlocks.size > 0) return false;

    const snap = await parseSnapshot(data);
    if (!snap || snap.network !== this.ledger.network) return false;

    for (const acc of snap.accounts) this.ledger.registerAccount(acc);
    for (const block of snap.blocks) await this.ledger.addBlock(block);

    this.lastSnapshotBytes = this.ledger.estimateBlockchainSizeBytes();
    this.emit('snapshot:applied', { epochBlock: snap.epochBlock, blocks: snap.blocks.length });
    return true;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async submitBlock(block: AccountBlock | EngineBlock): Promise<{ success: boolean; error?: string }> {
    const eb = block as unknown as EngineBlock;
    const result = this.ledger.addBlock(eb);
    if (result.success) {
      // Phase 1: gossip the engine block to peers (hex-encoded). Best-effort so a
      // publish failure never breaks the local commit. Engine blocks never route
      // through the legacy serializeBlock/voteIfConflict path.
      try { this.net.publishEngineBlock(eb); } catch { /* best-effort */ }
      // Slice 2: notify the recipient's inbox so it can pull this send even when
      // it does not subscribe to the sender's shard (Slice 3). Best-effort.
      if (eb.type === 'send' && eb.recipient) {
        try { await this.sendEngineInboxSignal(eb); } catch { /* best-effort */ }
      }
    }
    return result;
  }

  /** Slice 2: publish an engine-signed inbox signal to a send's recipient. */
  private async sendEngineInboxSignal(block: EngineBlock): Promise<void> {
    const appKeys = this.localKeys.get(block.accountId);
    if (!appKeys || !block.recipient) return;
    const amount = Number(block.amount ?? 0);
    const payload = `inbox:${block.hash}:${block.accountId}:${block.recipient}:${amount}`;
    const signature = engineSign(payload, engineKeysFromAppPrivate(appKeys.priv).priv);
    this.net.publishInboxSignal(block.recipient, block.accountId, block.hash, amount, signature);
  }

  /** Register as a storage provider. capacityGB = 0 deregisters. */
  async registerStorage(pub: string, capacityGB: number, keys: KeyPair): Promise<{ success: boolean; error?: string }> {
    const result = await this.ledger.createStorageRegister(pub, capacityGB, keys, getDeviceId());
    if (!result.block) return { success: false, error: result.error };
    const submitResult = await this.submitBlock(result.block);
    if (submitResult.success) {
      // Gossip live storage stats so all peers see accurate free-space immediately.
      setTimeout(() => this.storage.broadcastStorageStats(pub, keys).catch(() => {}), 2_000);
    }
    return submitResult;
  }

  /**
   * Re-publish all local blocks to connected peers so they respond with their own
   * blocks. Use this when provider stats look stale — a peer may have sent its
   * storage-register block before this node joined the GossipSub mesh.
   */
  async broadcastLocalState(): Promise<void> {
    await this.publishLocalData(false);  // full (non-incremental) publish triggers peer replies
  }

  /** Deregister from the storage ledger entirely. */
  async deregisterStorage(pub: string, keys: KeyPair): Promise<{ success: boolean; error?: string }> {
    const result = await this.ledger.createStorageDeregister(pub, keys);
    if (!result.block) return { success: false, error: result.error };
    const submitResult = await this.submitBlock(result.block);
    if (submitResult.success) {
      setTimeout(() => this.storage.broadcastStorageStats(pub, keys).catch(() => {}), 2_000);
    }
    return submitResult;
  }

  /** Distribute stored CIDs to up to 10 network providers. Pass all CIDs that must be pinned together (e.g. metaCid + contentCid). */
  async distributeContent(cids: string | string[], uploaderPub: string, keys: KeyPair): Promise<{ providers: string[]; error?: string }> {
    const cidArr = Array.isArray(cids) ? cids : [cids];
    return this.storage.distributeContent(cidArr[0], uploaderPub, keys, cidArr.slice(1));
  }

  /**
   * Delete content from local storage and broadcast a signed delete request so
   * all caching providers also drop their copies immediately.
   */
  async deleteContent(cids: string[], ownerPub: string, keys: KeyPair): Promise<void> {
    // Delete locally first
    for (const cid of cids) {
      await this.store.deleteBlock(cid);
    }
    // Broadcast to providers
    const ts = Date.now();
    const payload = `delete:${cids.join(',')}:${ownerPub}:${ts}`;
    const signature = await signData(payload, keys);
    this.net.publishDeleteRequest({ cids, ownerPub, timestamp: ts, signature });
  }

  /**
   * Replace content: delete old CIDs locally, broadcast a signed ReplaceRequest
   * so every network provider swaps old→new, then distribute the new CIDs.
   * Pass all related CIDs (meta + inner content) for both old and new versions.
   */
  async replaceContent(
    oldCids: string[],
    newCids: string[],
    ownerPub: string,
    keys: KeyPair,
  ): Promise<{ providers: string[]; error?: string }> {
    for (const cid of oldCids) {
      await this.store.deleteBlock(cid);
    }
    return this.storage.replaceContent(
      oldCids[0], newCids[0], ownerPub, keys,
      oldCids.slice(1), newCids.slice(1),
    );
  }

  // ── Community relay registry ──────────────────────────────────────────────

  async announceRelay(addr: string, keys: KeyPair): Promise<void> {
    await this.net.publishRelayAnnouncement(addr, keys);
  }

  getKnownRelays() {
    return this.net.getKnownRelays();
  }

  private async checkRelayLiveness(): Promise<void> {
    if (this.status === 'stopped') return;
    const connected = new Set(
      (this.net.libp2p?.getConnections?.() ?? []).map(c => c.remotePeer.toString())
    );
    for (const r of this.net.getKnownRelays()) {
      if (connected.has(r.peerId)) {
        // Still connected — refresh lastSeen
        await this.net.upsertKnownRelay(r.addr, r.announcerPub);
      } else {
        try {
          await this.net.libp2p.dial(multiaddr(r.addr));
          await this.net.upsertKnownRelay(r.addr, r.announcerPub);
        } catch {
          await this.net.markRelayFailed(r.addr);
        }
      }
    }
  }

  getStats(): NodeStats {
    const netStats = this.net.getStats();
    return {
      status: this.status, uptime: this.startTime ? Date.now() - this.startTime : 0,
      network: this.ledger.network, peerId: netStats.peerId,
      peerCount: netStats.peerCount, synapses: netStats.synapses,
    };
  }

  async switchNetwork(network: NetworkType): Promise<void> {
    const wasRunning = this.status !== 'stopped';
    if (wasRunning) await this.stop();
    this.ledger = new DAGLedger(network);
    this.net = new Libp2pNetwork(network);
    this.emit('network:switched', network);
  }
}
