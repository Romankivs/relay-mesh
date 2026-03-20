/**
 * End-to-end Playwright tests for RelayMesh using real Chromium + WebRTC.
 *
 * Each test spins up the RelayMeshServer in-process, serves the simple-client
 * HTML via a local Express server, then opens real browser tabs that load the
 * page and join the conference through the UI.
 *
 * Chrome flags used:
 *   --use-fake-ui-for-media-stream   – auto-grants camera/mic permission dialogs
 *   --use-fake-device-for-media-stream – provides a synthetic test-pattern stream
 *     so getUserMedia() succeeds and real RTP packets flow between peers.
 *
 * Environment variables (all optional):
 *   SIGNALING_URL  – override the signaling server URL (default: local server)
 *   CONFERENCE_ID  – conference room name (default: "e2e-test")
 *   REGION         – label injected into participant names (default: "local")
 *   PARTICIPANT_COUNT – how many browser tabs to open (default: 3)
 */

import { test, expect, chromium, Browser, BrowserContext, Page } from '@playwright/test';
import * as http from 'http';
import * as path from 'path';
import express from 'express';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SIGNALING_PORT = 9100;
const STATIC_PORT = 9101;
const CONFERENCE_ID = process.env.CONFERENCE_ID ?? 'e2e-test';
const REGION = process.env.REGION ?? 'local';
const PARTICIPANT_COUNT = parseInt(process.env.PARTICIPANT_COUNT ?? '3', 10);
const SIGNALING_URL =
  process.env.SIGNALING_URL ?? `ws://localhost:${SIGNALING_PORT}`;
const CLIENT_URL = `http://localhost:${STATIC_PORT}/examples/simple-client/index.html`;

/** Wait until predicate returns true, polling every 200 ms. */
async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 30_000,
  label = 'condition'
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

/** Read the text content of a DOM element by selector. */
async function getText(page: Page, selector: string): Promise<string> {
  return page.$eval(selector, (el) => (el as HTMLElement).innerText.trim());
}

/** Fill an input and clear it first. */
async function fillInput(page: Page, selector: string, value: string) {
  await page.fill(selector, '');
  await page.fill(selector, value);
}

// ---------------------------------------------------------------------------
// Server fixtures (shared across tests in this file)
// ---------------------------------------------------------------------------

let signalingServer: import('../../src/server/relay-mesh-server').RelayMeshServer;
let staticServer: http.Server;

test.beforeAll(async () => {
  // Start signaling server
  // Import from compiled dist — the project uses CommonJS so we can't
  // dynamically import TS source directly.
  // Run `npm run build` if this fails with "Cannot find module".
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { RelayMeshServer } = require('../../dist/server/relay-mesh-server') as typeof import('../../src/server/relay-mesh-server');
  signalingServer = new RelayMeshServer({
    port: SIGNALING_PORT,
    host: 'localhost',
    tlsEnabled: false,
    authRequired: false,
  });
  await signalingServer.start();

  // Serve the workspace root statically so the browser can load the HTML and
  // the built browser bundle at dist/browser/relay-mesh.esm.js
  const app = express();
  app.use(express.static(path.resolve(__dirname, '../..')));
  await new Promise<void>((resolve, reject) => {
    staticServer = app.listen(STATIC_PORT, () => resolve());
    staticServer.once('error', reject);
  });
});

test.afterAll(async () => {
  await signalingServer?.stop().catch(() => {});
  await new Promise<void>((resolve) => staticServer?.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

/** Stagger delay between participant joins/opens to avoid overwhelming the signaling server. */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const JOIN_DELAY_MS = parseInt(process.env.JOIN_DELAY_MS ?? '3000', 10);

/** Open a new browser context with fake media flags and load the client page.
 *  A configurable delay is applied before opening to avoid overwhelming the
 *  signaling server when multiple instances are launched in quick succession. */
const OPEN_DELAY_MS = parseInt(process.env.OPEN_DELAY_MS ?? '3000', 10);
async function openParticipant(
  browser: Browser,
  name: string
): Promise<{ context: BrowserContext; page: Page }> {
  await delay(OPEN_DELAY_MS);
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
  });
  const page = await context.newPage();

  // Surface browser console to Node stdout for debugging
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.error(`[browser:${name}] ${msg.text()}`);
    }
  });

  await page.goto(CLIENT_URL);
  return { context, page };
}

/** Fill in the form fields and click Join, then wait until state = CONNECTED. */
async function joinConference(
  page: Page,
  name: string,
  conferenceId = CONFERENCE_ID
): Promise<void> {
  await fillInput(page, '#serverUrl', SIGNALING_URL);
  await fillInput(page, '#userName', name);
  await fillInput(page, '#conferenceId', conferenceId);
  await page.click('#joinBtn');

  await waitFor(
    async () => {
      const state = await getText(page, '#state');
      // State machine emits lowercase enum values ('connected'), but the DOM
      // may also show the initial uppercase default ('IDLE') before any event fires.
      return state.toLowerCase() === 'connected';
    },
    30_000,
    `${name} to reach CONNECTED`
  );
}

/** Pull live WebRTC stats from the page via the exposed debugClient(). */
async function getWebRTCStats(page: Page): Promise<{
  participantId: string;
  role: string;
  participantCount: number;
  peerConnectionCount: number;
}> {
  return page.evaluate(() => {
    const client = (window as any).debugClient?.();
    if (!client) throw new Error('debugClient not available');
    const info = client.getConferenceInfo();
    const pcs = client?.mediaHandler?.peerConnections ?? new Map();
    return {
      participantId: info?.participantId ?? '',
      role: info?.role ?? '',
      participantCount: info?.participantCount ?? 0,
      peerConnectionCount: pcs.size,
    };
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('RelayMesh E2E — real browser WebRTC', () => {
  let browser: Browser;

  test.beforeAll(async () => {
    browser = await chromium.launch({
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });
  });

  test.afterAll(async () => {
    await browser?.close();
  });

  const FINISH_DELAY_MS = parseInt(process.env.FINISH_DELAY_MS ?? '10000', 10);

  // -------------------------------------------------------------------------
  test('single participant can join and reach CONNECTED state', async () => {
    const { context, page } = await openParticipant(browser, 'Solo');
    try {
      await joinConference(page, `Solo-${REGION}`);
      const state = await getText(page, '#state');
      expect(state.toLowerCase()).toBe('connected');
    } finally {
      await delay(FINISH_DELAY_MS);
      await context.close();
    }
  });

  // -------------------------------------------------------------------------
  test('two participants connect and see each other', async () => {
    const p1 = await openParticipant(browser, 'Alice');
    const p2 = await openParticipant(browser, 'Bob');
    try {
      // Join staggered — openParticipant already delays, joins follow the same cadence
      await joinConference(p1.page, `Alice-${REGION}`);
      await delay(JOIN_DELAY_MS);
      await joinConference(p2.page, `Bob-${REGION}`);

      // Both should eventually see 2 participants
      await waitFor(
        async () => {
          const c1 = parseInt(await getText(p1.page, '#participantCount'), 10);
          const c2 = parseInt(await getText(p2.page, '#participantCount'), 10);
          return c1 >= 2 && c2 >= 2;
        },
        30_000,
        'both participants to see each other'
      );

      const stats1 = await getWebRTCStats(p1.page);
      const stats2 = await getWebRTCStats(p2.page);

      expect(stats1.participantCount).toBeGreaterThanOrEqual(2);
      expect(stats2.participantCount).toBeGreaterThanOrEqual(2);

      // One of them should be the relay
      const roles = [stats1.role, stats2.role];
      expect(roles).toContain('relay');
    } finally {
      await delay(FINISH_DELAY_MS);
      await p1.context.close();
      await p2.context.close();
    }
  });

  // -------------------------------------------------------------------------
  test(`${PARTICIPANT_COUNT} participants form a relay mesh topology`, async () => {
    const participants: Array<{ context: BrowserContext; page: Page }> = [];
    try {
      // Open all tabs
      for (let i = 0; i < PARTICIPANT_COUNT; i++) {
        participants.push(await openParticipant(browser, `P${i}`));
      }

      // Join all concurrently
      // Join staggered — 3s between each so topology can settle before next peer arrives
      for (let i = 0; i < PARTICIPANT_COUNT; i++) {
        if (i > 0) await delay(JOIN_DELAY_MS);
        await joinConference(participants[i].page, `P${i}-${REGION}`);
      }

      // Wait until every participant sees the full count
      await waitFor(
        async () => {
          const counts = await Promise.all(
            participants.map(({ page }) =>
              getText(page, '#participantCount').then((t) => parseInt(t, 10))
            )
          );
          return counts.every((c) => c >= PARTICIPANT_COUNT);
        },
        60_000,
        `all ${PARTICIPANT_COUNT} participants to see each other`
      );

      // Verify topology: at least one relay exists
      const stats = await Promise.all(
        participants.map(({ page }) => getWebRTCStats(page))
      );
      const relayCount = stats.filter((s) => s.role === 'relay').length;
      expect(relayCount).toBeGreaterThanOrEqual(1);

      // Each participant should have at least one peer connection
      stats.forEach((s) => {
        expect(s.peerConnectionCount).toBeGreaterThanOrEqual(1);
      });
    } finally {
      await delay(FINISH_DELAY_MS);
      await Promise.all(participants.map(({ context }) => context.close()));
    }
  });

  // -------------------------------------------------------------------------
  test('relay failover: relay leaves and conference recovers', async () => {
    const participants: Array<{ context: BrowserContext; page: Page }> = [];
    try {
      for (let i = 0; i < 3; i++) {
        participants.push(await openParticipant(browser, `FO${i}`));
      }

      for (let i = 0; i < 3; i++) {
        if (i > 0) await delay(JOIN_DELAY_MS);
        await joinConference(participants[i].page, `FO${i}-${REGION}`);
      }

      // Wait for full mesh
      await waitFor(
        async () => {
          const counts = await Promise.all(
            participants.map(({ page }) =>
              getText(page, '#participantCount').then((t) => parseInt(t, 10))
            )
          );
          return counts.every((c) => c >= 3);
        },
        30_000,
        'all 3 to connect'
      );

      // Find the relay tab
      const statsBeforeLeave = await Promise.all(
        participants.map(({ page }) => getWebRTCStats(page))
      );
      const relayIndex = statsBeforeLeave.findIndex((s) => s.role === 'relay');
      expect(relayIndex).toBeGreaterThanOrEqual(0);

      // Relay leaves
      await participants[relayIndex].page.click('#leaveBtn');
      await participants[relayIndex].context.close();
      participants.splice(relayIndex, 1);

      // Remaining participants should recover — a new relay gets elected
      await waitFor(
        async () => {
          const roles = await Promise.all(
            participants.map(({ page }) =>
              getText(page, '#role').then((r) => r.toLowerCase())
            )
          );
          return roles.some((r) => r === 'relay');
        },
        30_000,
        'new relay to be elected after failover'
      );

      // Both remaining participants should still be CONNECTED
      for (const { page } of participants) {
        const state = await getText(page, '#state');
        expect(state.toLowerCase()).toBe('connected');
      }
    } finally {
      await delay(FINISH_DELAY_MS);
      await Promise.all(participants.map(({ context }) => context.close().catch(() => {})));
    }
  });

  // -------------------------------------------------------------------------
  test('participant can leave and rejoin cleanly', async () => {
    const { context, page } = await openParticipant(browser, 'Rejoiner');
    try {
      await joinConference(page, `Rejoiner-${REGION}`);
      expect((await getText(page, '#state')).toLowerCase()).toBe('connected');

      await page.click('#leaveBtn');
      await waitFor(
        async () => (await getText(page, '#state')).toLowerCase() === 'idle',
        10_000,
        'state to return to IDLE'
      );

      // Rejoin
      await joinConference(page, `Rejoiner-${REGION}`);
      expect((await getText(page, '#state')).toLowerCase()).toBe('connected');
    } finally {
      await delay(FINISH_DELAY_MS);
      await context.close();
    }
  });

  // -------------------------------------------------------------------------
  test('collects real WebRTC getStats() metrics after connection', async () => {
    const p1 = await openParticipant(browser, 'StatsA');
    const p2 = await openParticipant(browser, 'StatsB');
    try {
      await joinConference(p1.page, `StatsA-${REGION}`);
      await delay(JOIN_DELAY_MS);
      await joinConference(p2.page, `StatsB-${REGION}`);

      await waitFor(
        async () => {
          const c = parseInt(await getText(p1.page, '#participantCount'), 10);
          return c >= 2;
        },
        30_000,
        'StatsA to see StatsB'
      );

      // Give RTP a moment to flow
      await p1.page.waitForTimeout(3000);

      // Pull raw getStats() from the first peer connection
      const rtcStats = await p1.page.evaluate(async () => {
        const client = (window as any).debugClient?.();
        if (!client) return null;
        const pcs: Map<string, RTCPeerConnection> =
          client?.mediaHandler?.peerConnections;
        if (!pcs || pcs.size === 0) return null;
        const [, pc] = [...pcs.entries()][0];
        const report = await pc.getStats();
        const result: Record<string, unknown>[] = [];
        report.forEach((s) => {
          if (s.type === 'candidate-pair' || s.type === 'inbound-rtp' || s.type === 'outbound-rtp') {
            result.push({ type: s.type, ...s });
          }
        });
        return result;
      });

      expect(rtcStats).not.toBeNull();
      expect(Array.isArray(rtcStats)).toBe(true);

      // At least one candidate-pair should be in succeeded state
      const succeededPair = (rtcStats as any[]).find(
        (s) => s.type === 'candidate-pair' && s.state === 'succeeded'
      );
      expect(succeededPair).toBeDefined();
    } finally {
      await delay(FINISH_DELAY_MS);
      await p1.context.close();
      await p2.context.close();
    }
  });
});
