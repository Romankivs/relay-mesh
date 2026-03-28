# Sub-Linear Connection Topology for Scalable Multi-Party WebRTC Conferencing

**Abstract** — Multi-party WebRTC conferencing scales poorly under full-mesh topology (O(N²) connections) and introduces infrastructure dependency under centralized SFU/MCU models. This paper presents a relay-mesh topology in which a dynamically elected participant subset acts as relay nodes, reducing per-participant connections to O(√N) while preserving decentralized media flow. We describe the topology formation algorithm, analyze connection complexity, and compare against existing approaches.

---

## 1. Introduction

In full-mesh WebRTC, each participant maintains N−1 simultaneous connections, producing O(N²) total connections — prohibitive at scale. Selective Forwarding Units (SFUs) address this but require dedicated server infrastructure and introduce a central failure point.

We propose a relay-mesh model where participants with favorable characteristics are elected as relay nodes by the group itself. The signaling server retains only a coordination role; all media flows peer-to-peer.

---

## 2. Topology Model

**Roles.** Each participant is assigned one of two roles: a *relay node* that forwards media between groups, or a *regular node* that connects exclusively to its assigned relay.

**Connection Structure.** Given N participants and R = ⌈√N⌉ relay nodes, each regular node maintains 1 connection; each relay maintains (R−1) + G connections, where G ≤ ⌈N/R⌉ is its group size. Total connections across the session:

```
Total = R·(R−1)/2 + N − R ≈ O(N)
```

Full mesh requires N·(N−1)/2 = O(N²). At N = 25, full mesh requires 300 connections; relay-mesh requires approximately 45.

| N  | Full Mesh | Relay-Mesh | Relay Nodes |
|----|-----------|------------|-------------|
| 4  | 6         | 5          | 2           |
| 9  | 36        | 15         | 3           |
| 16 | 120       | 28         | 4           |
| 25 | 300       | 45         | 5           |

**Relay Count.** R = ⌈√N⌉ minimizes the maximum connection count on any single node, since a relay's peak load (R−1) + ⌈N/R⌉ is minimized when R ≈ √N.

---

## 3. Topology Formation

Group assignment proceeds in two phases. First, each regular node is assigned to the relay with minimum measured round-trip latency. Second, if any relay's group exceeds 80% of the configured maximum while another is below 50%, the highest-latency member of the overloaded relay is reassigned, provided the latency increase is under 50 ms. Relay nodes form a full mesh among themselves, ensuring any-to-any media reachability.

---

## 4. Discussion

Relay nodes bear higher bandwidth and CPU load than regular nodes, mitigated by the election algorithm which selects only participants with sufficient upload bandwidth, favorable NAT type, and available device resources. On relay failure, a replacement is promoted from the affected group within a bounded time window, leaving other groups undisturbed.

Compared to SFU-based systems, relay-mesh eliminates server-side media infrastructure entirely. The trade-off is that relay quality depends on end-user conditions rather than provisioned server capacity.

---

## 5. Conclusion

The relay-mesh topology achieves O(N) total connections and O(√N) connections per relay node by organizing participants into groups around dynamically elected relays. This provides a scalable alternative to both full-mesh and SFU architectures for deployments where infrastructure cost or centralization is a constraint.

---

*Keywords: WebRTC, peer-to-peer conferencing, topology optimization, relay selection, connection scalability*
