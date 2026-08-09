# Cloud infrastructure — cloudify.ro (Acvile) via OpenStack

Runbook for provisioning super-nodes / relays on the cloudify.ro platform, which
exposes a standard **OpenStack** API (Keystone v3 + Nova + Neutron + Cinder + Glance).

## Access

| | |
|---|---|
| Auth URL | `https://identity.eu-east-1.acvile.cloud/v3` |
| Region | `eu-east-1` |
| Auth type | `v3applicationcredential` (application credential, not user/password) |
| Credentials file | `lucian.openrc` — repo root, **gitignored**, never commit |
| Project ID | `cd80da3ceccb474390e75dd5029155db` |
| CLI | `python-openstackclient` 10.2.1 in `.openstack-venv/` (gitignored) |

The credential file holds a live `OS_APPLICATION_CREDENTIAL_SECRET`. Treat it like
a private key: never paste it into a commit, an issue, a log, or a chat. If it
leaks, revoke it in the cloudify.ro console and reissue.

### Setup (one-time)

```powershell
powershell -File scripts/os-setup.ps1     # creates .openstack-venv + installs the CLI
```

### Running commands

```sh
./scripts/os.sh flavor list               # wrapper: sources lucian.openrc, runs the venv CLI
./scripts/os.sh server list
```

PowerShell equivalent (no wrapper — set the vars from `lucian.openrc` yourself):

```powershell
$env:OS_AUTH_TYPE='v3applicationcredential'
$env:OS_AUTH_URL='https://identity.eu-east-1.acvile.cloud/v3'
$env:OS_IDENTITY_API_VERSION='3'; $env:OS_REGION_NAME='eu-east-1'; $env:OS_INTERFACE='public'
$env:OS_APPLICATION_CREDENTIAL_ID='...'; $env:OS_APPLICATION_CREDENTIAL_SECRET='...'
.\.openstack-venv\Scripts\openstack.exe server list
```

Verify access at any time with `./scripts/os.sh token issue`.

## Platform notes (outage of 2026-08-08 — RESOLVED 2026-08-09)

Compute provisioning was down platform-wide on 2026-08-08 (builds failed from
cloudify's own panel too). **Resolved next day** — `server create` via the API
works normally now (ACTIVE in <30 s). Kept for the record, since the failure mode
is instructive: builds stuck at `scheduling`/`spawning`, `BUILD → ERROR`, fault
hidden, no host assigned. If that pattern reappears, it's the platform — probe one
boot, then stop and wait (don't debug our API usage; the syntax matches cloudify's
own docs, whose example flavor `m1.c3.3`/image are stale).

Verified state of the API surface:

| Operation | Via API |
|---|---|
| Auth, list/show everything, quota | ✅ |
| Networks, subnets, routers, sec-groups, volumes | ✅ (these persisted) |
| Keypairs (API-created) | ❌ was silently deleted (~40 min) — create keys in the panel |
| Keypairs (panel-created) | ✅ sync into Nova and persist (`neuron-ops`) |
| `server create` | ✅ works (post-outage); boots on `neuron-net`, public IP via floating IP |

Standing rules: **Ubuntu 26 images only** (`base-ubuntu-26.04`
`e321df69-7b8f-4d0b-9375-88a10eb42527`). SSH key: panel-registered `neuron-ops`
(local private key `~/.ssh/neuron-ops`). **Do not rebuild the relay boxes** —
their public IPs must stay stable (baked into the app's bootstrap list).

## Live relay boxes (created 2026-08-09)

| Box | Public IP | Private | Flavor / image |
|---|---|---|---|
| `neuron-relay-1` | **80.97.27.224** | 10.10.0.214 | `b2i.2c-2g` / Ubuntu 26.04 |
| `neuron-relay-2` | **80.97.27.112** | 10.10.0.55 | `b2i.2c-2g` / Ubuntu 26.04 |

SSH: `ssh -i ~/.ssh/neuron-ops ubuntu@<IP>`; relay software via
`scripts/setup-relay-box.sh`; roles: archive super-node + attester each
(see [SUPERNODE.md](SUPERNODE.md), dev-relay variant).

## Account state (2026-08-08, after the attempt)

- **0 servers, 0 keypairs, 0 floating IPs.**
- Networks: **`public`** (`0a92fd7a-…`, `router:external` + `shared`) and
  **`neuron-net`** (`10.10.0.0/24`, created for the relay boxes) routed outward via
  **`neuron-router`**.
- Security groups: `default`, and **`neuron-relay`** (TCP 22, 9090, 9091, 9092 open).
- Availability zone: `nova`. Volume types: `gp-nvme`, `NVMe`, `HDD`,
  `NVMe_Multiattach`, `HDD_Multiattach`, `__DEFAULT__`.

### Quota

| Limit | Value |
|---|---|
| Instances | 20 |
| vCPUs | 128 |
| RAM | 160 GB |
| Floating IPs | unlimited (`-1`) |
| Volumes / volume GB | 50 / 2000 |
| Keypairs | 100 |

## Server types (flavors)

Four families. `ID` or `Name` both work in `server create --flavor`.

| Family | Shape | Sizes |
|---|---|---|
| **`b2i.*`** (`118260xx`) | burstable, 1 GB RAM per vCPU, small disk | `2c-2g` (40 GB) → `16c-16g` (320 GB) |
| **`c5a.*`** (`4005xx`) | compute-optimised, 1.5 GB per vCPU | `4c-6g` (100 GB) → `16c-24g` (320 GB) |
| **`gp2.*`** (`8260xx`) / **`ga3.*`** (`7003xx`) | general purpose, 2 GB per vCPU | `2c-4g` (80 GB) → `64c-128g` / `96c-192g` (720–960 GB) |
| **`ai.bw.*`** (`9017003xx`) | GPU (RTX 2000/4000, ×1 and ×2), **disk 0 → must boot from volume** | `8c-16g` → `12c-24g` |

Sizing note for this project: a relay/super-node is RAM- and bandwidth-bound (the
archive is currently in RAM — see [SUPERNODE.md](SUPERNODE.md) → Scaling), so
prefer the 2 GB-per-vCPU `gp2.*`/`ga3.*` line over burstable `b2i.*` for anything
holding archive state.

## Images

Curated `base-*` images are the ones to use (`base-debian-13`, `base-almalinux-10`,
`base-ubuntu-*`, `base-centos-stream-10`, …), plus prebuilt app images
(`app-coolify-ubuntu-24.04`, `app-nvidia-ai-ubuntu-24.04`). Legacy uncurated entries
(`Debian 8`, `CentOS 7`, `Ubuntu 18.04 LTS`) also exist — don't use them.

Watch out: several names are **duplicated across different IDs** (`base-almalinux-8`
appears 3×, `base-centos-stream-9` 2×). Always resolve to an ID first —
`./scripts/os.sh image list --name base-debian-13 -f value -c ID` — and pass the ID,
or `server create` may pick a different build than you expect.

```sh
./scripts/os.sh image list --status active
./scripts/os.sh image show <id>
```

## Spinning up an instance (once cloudify fixes provisioning)

Relay-box spec: 2× **`b2i.2c-2g`** (cheapest: 2 vCPU / 2 GB / 40 GB), **Ubuntu 26**,
each with its own public IP, TCP 22 + 9090–9092 open.

```sh
./scripts/os.sh server create neuron-relay-1 \
  --flavor b2i.2c-2g \
  --image e321df69-7b8f-4d0b-9375-88a10eb42527 \
  --network neuron-net --security-group neuron-relay \
  --key-name neuron-ops --wait
./scripts/os.sh floating ip create public
./scripts/os.sh server add floating ip neuron-relay-1 <FIP>
# (repeat for neuron-relay-2; GPU flavors have disk 0 → add:
#  --boot-from-volume 100 --volume-type gp-nvme)
```

Then provision the relay software over SSH:

```sh
scp -i ~/.ssh/neuron-ops scripts/setup-relay-box.sh ubuntu@<IP>:/tmp/
ssh -i ~/.ssh/neuron-ops ubuntu@<IP> "sudo bash /tmp/setup-relay-box.sh"
curl http://<IP>:9092/relay-info     # → ready: true, note the peerId
```

Federate the two boxes (each lists the other in `PEER_RELAYS`) — commands in the
header of [`setup-relay-box.sh`](../scripts/setup-relay-box.sh). If API creation
still errors while the panel works, fall back to creating the same spec in the
panel and continue from the `scp` step.

## Floating IPs

Floating IPs give a **stable address that survives rebuilding the instance** (the
relay's bootstrap multiaddr / DNS must not change). A FIP associates with a port on
an *internal* network routed to the external one — the topology for that
(`neuron-net` 10.10.0.0/24 + `neuron-router` gatewayed to `public`) **already
exists** (created 2026-08-08):

```sh
# allocate + associate (once the instance exists on neuron-net)
./scripts/os.sh floating ip create public
./scripts/os.sh server add floating ip neuron-relay-1 <FIP>

# move it to a replacement instance later (the whole point)
./scripts/os.sh server remove floating ip neuron-relay-1 <FIP>
./scripts/os.sh server add floating ip neuron-relay-2 <FIP>
```

If the panel instead puts panel-created instances straight on `public` (or its own
network) with a fixed IP, that's fine for the dev boxes — note whether the panel IP
survives rebuilds; if not, prefer the FIP model. Whether Neutron FIP writes survive
the panel reconciler is untested — if a FIP vanishes like the keypair did, manage
IPs from the panel instead.

## Teardown

Unused floating IPs and volumes usually keep billing after the server is gone. Delete
in this order:

```sh
./scripts/os.sh server delete neuron-relay-1 --wait
./scripts/os.sh floating ip delete <FIP>
./scripts/os.sh volume list && ./scripts/os.sh volume delete <id>
```

## After the instance is up

Provisioning the box itself (Node, pm2, relay, TLS, `PEER_RELAYS` federation, bootstrap
peer IDs) is covered by [SUPERNODE.md](SUPERNODE.md) — this document stops at "you have
a reachable VM".
