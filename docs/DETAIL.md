# LAN listener reference

The DSH host plugin exposes package inventory for paired computers. The Python [profile sync tool](SYNC.md) handles selection, portable preferences and installation on the receiving computer.

| Request | Who can use it | Result |
| --- | --- | --- |
| GET `/lan-sync/info` | Unpaired or paired device | Device identity and pairing status. Only a loopback caller can obtain the active pairing code. |
| POST `/lan-sync/pair` | Peer proving possession of the pairing code | Registers the peer public key. |
| GET `/lan-sync/snapshot` | Signed peer request | Exports origin and installed package metadata. |
| POST `/lan-sync/stage` | Signed peer request | Stores a snapshot and returns comparison counts. Installation requires a separate local action. |

Peer requests are signed with Ed25519. Use the listener on a trusted LAN or encrypted overlay. The default listener binds TCP port 7411 on all interfaces. Configure `bindHost` to the intended interface, or to `127.0.0.1` for local testing. The `port` and `dataDir` settings control the listening port and private storage. Restrict access to your intended peers.

The host inventory includes identifying metadata such as the machine name. Keep pairing codes, snapshots, device identities and the plugin data directory private. The local helper separately exports an allowlist of portable preferences and market indexes. Model credentials, conversation history and workspace contents remain local.
