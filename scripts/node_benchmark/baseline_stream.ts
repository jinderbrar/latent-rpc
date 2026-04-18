/**
 * baseline_stream.ts
 * ------------------
 * Port of the `runBaselineHeadless` logic from ResearchPortal.tsx.
 * Connects to /ws/baseline, receives JSON token frames, measures metrics.
 */

import { WebSocket } from 'ws';

export interface BaselineStats {
  payloadBytes: number;
  tokens:       number;
  ttft:         number | null;
  tps:          number;
  totalMs:      number;
}

/**
 * Run the baseline JSON stream headlessly.
 * Does NOT process token text — only measures bytes, timing, and count.
 */
export function runBaselineStreamAsync(
  backend: string,
  prompt:  string
): Promise<BaselineStats> {
  return new Promise((resolve) => {
    const wsUrl = backend.replace(/^http/, 'ws') + '/ws/baseline';
    const ws    = new WebSocket(wsUrl);

    let tokens       = 0;
    let payloadBytes = 0;
    let ttft: number | null = null;
    let sendTime     = 0;
    const wallStart  = performance.now();

    ws.on('open', () => {
      sendTime = performance.now();
      ws.send(prompt);
    });

    ws.on('message', (raw: Buffer | string) => {
      const now = performance.now();
      if (ttft === null) ttft = now - sendTime;

      const text = raw.toString('utf-8');
      payloadBytes += Buffer.byteLength(text, 'utf-8');

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(text);
      } catch {
        return; // ignore malformed frames
      }

      if (msg['done'] === true) {
        ws.close();
        return;
      }

      tokens++;
    });

    ws.on('close', () => {
      const totalMs = performance.now() - wallStart;
      resolve({
        payloadBytes,
        tokens,
        ttft,
        tps:     tokens / (totalMs / 1000),
        totalMs,
      });
    });

    ws.on('error', (err) => {
      console.error('[baseline] WebSocket error:', err.message);
      resolve({ payloadBytes, tokens, ttft, tps: 0, totalMs: performance.now() - wallStart });
    });
  });
}
