# Serverless Media Distribution in WebRTC Conferencing via Dynamic Relay Node Election

**Abstract** — SFU and MCU architectures for multi-party WebRTC conferencing introduce infrastructure cost, operational complexity, and centralized failure points. This paper presents a decentralized alternative in which relay nodes are dynamically elected from the participant pool using a weighted multi-criteria scoring function. Media flows exclusively through peer-to-peer connections; the signaling server retains only a coordination role. We describe the election mechanism, the scoring model, and applicable deployment conditions.

---

## 1. Introduction

WebRTC enables browser-native peer-to-peer media communication. Scaling beyond two participants has historically required server-side media infrastructure: SFUs forward streams selectively, MCUs mix them server-side. Both require provisioned capacity proportional to session load and introduce a central failure domain.

An alternative is to elect participants themselves as media forwarders. Participants with sufficient bandwidth, favorable NAT characteristics, and available device resources can relay streams on behalf of others. The challenge is selecting relay nodes consistently across all clients without central arbitration. We describe a deterministic scoring mechanism that achieves this using only the existing signaling channel.

---

## 2. Relay Election Mechanism

### 2.1 Metrics Collection

Each participant continuously measures five categories: **bandwidth** (upload-weighted, as relay nodes are net senders), **NAT type** (Open to Symmetric; Symmetric participants are ineligible), **latency** (mean RTT to all peers via RTCP), **stability** (packet loss, jitter, uptime, reconnection count), and **device capability** (CPU, memory, codec support, hardware acceleration). Metrics are broadcast to all participants via the signaling channel at a configurable interval (default: 30 s).

### 2.2 Scoring Function

Each participant computes a relay score for every other participant:

```
score = w_b·S_bandwidth + w_n·S_nat + w_l·S_latency + w_s·S_stability + w_d·S_device
```

Default weights: bandwidth 0.30, NAT 0.25, latency 0.20, stability 0.15, device 0.10. All components are normalized to [0, 1]. Because every participant applies the same deterministic function to the same broadcast metrics, all clients independently arrive at identical relay assignments — no voting protocol is required.

### 2.3 Eligibility and Relay Count

A participant is eligible only if upload bandwidth meets a minimum threshold (default: 5 Mbps), NAT type is not Symmetric, and connection uptime exceeds 30 seconds. The number of elected relays is R = ⌈√N⌉ for N participants.

---

## 3. Role Transition and Adaptation

On election, the signaling server notifies the participant of its relay role. It activates its forwarding engine, configures routing tables, and begins accepting streams from assigned group members. Re-evaluation occurs periodically and on significant metric changes. A relay whose score falls below the lowest-scoring non-relay participant is demoted and replaced, ensuring relay quality tracks actual conditions throughout the session.

---

## 4. Discussion

The model eliminates server-side media infrastructure, requiring only a lightweight WebSocket signaling server. Correctness depends on metric accuracy; in open deployments, validation mechanisms may be warranted. Relay performance is bounded by end-user conditions rather than provisioned server capacity, making the approach best suited to deployments with reasonably capable participants — enterprise conferencing, educational platforms, and developer tooling.

---

## 5. Conclusion

Dynamic relay election enables multi-party WebRTC conferencing without dedicated media servers. A deterministic weighted scoring function over participant-reported metrics produces consistent relay assignments across all clients without coordination overhead. The result is a conferencing architecture whose media infrastructure cost scales with participant capability rather than session count.

---

*Keywords: WebRTC, decentralized conferencing, relay election, SFU-free architecture, peer-to-peer media distribution*
