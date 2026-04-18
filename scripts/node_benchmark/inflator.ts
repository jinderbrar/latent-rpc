/**
 * inflator.ts
 * -----------
 * Node.js V8 port of inflator.worker.ts.
 *
 * Browser API → Node.js shims:
 *   fetch('/dictionary.bin')  →  fs.readFileSync(DICT_PATH)
 *   new WebSocket(...)        →  ws npm package (identical event API)
 *   postMessage(...)          →  InflatorCallbacks passed at construction
 *   performance.now()         →  Node.js built-in (same since Node 16)
 *   TextDecoder / DataView    →  V8 built-ins — unchanged
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocket } from 'ws';

// ─── Dictionary path ──────────────────────────────────────────────────────────
// Resolve relative to this file: ../../frontend/public/dictionary.bin
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DICT_PATH = path.resolve(__dirname, '../../frontend/public/dictionary.bin');

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StreamStats {
  binaryBytes: number;
  tokens:      number;
  ttft:        number | null;
  tps:         number;
  totalMs:     number;
}

export interface InflatorCallbacks {
  /** Called for each decoded text chunk. Only invoked when decode=true. */
  onToken?: (text: string, stats: StreamStats) => void;
  /** Always called when the stream ends. */
  onDone:  (stats: StreamStats) => void;
}

// ─── Dictionary state (loaded once per process) ───────────────────────────────
let offsets:     Uint32Array | null = null;
let stringBlock: Uint8Array  | null = null;
let maxTokenId   = 0;

const textDecoder = new TextDecoder('utf-8');

/**
 * Load and parse dictionary.bin from disk.
 * Binary layout (identical to browser worker):
 *   [0..3]   magic  'LRPC'
 *   [4..7]   maxTokenId  (uint32 LE)
 *   [8..]    offsets table (uint32 LE, maxTokenId+2 entries)
 *            string block (UTF-8 bytes)
 */
export function loadDictionary(): void {
  if (offsets !== null) return; // already loaded

  if (!fs.existsSync(DICT_PATH)) {
    throw new Error(`dictionary.bin not found at: ${DICT_PATH}`);
  }

  const nodeBuf = fs.readFileSync(DICT_PATH);
  // Convert Node Buffer to a plain ArrayBuffer (zero-copy via subarray)
  const buffer: ArrayBuffer = nodeBuf.buffer.slice(
    nodeBuf.byteOffset,
    nodeBuf.byteOffset + nodeBuf.byteLength
  ) as ArrayBuffer;

  const magic = textDecoder.decode(new Uint8Array(buffer, 0, 4));
  if (magic !== 'LRPC') {
    throw new Error(`Invalid dictionary magic marker: "${magic}" (expected "LRPC")`);
  }

  const view   = new DataView(buffer);
  maxTokenId   = view.getUint32(4, true);

  const offsetCount      = maxTokenId + 2;
  const offsetsByteLength = offsetCount * 4;

  offsets     = new Uint32Array(buffer, 8, offsetCount);
  stringBlock = new Uint8Array(buffer, 8 + offsetsByteLength);

  console.log(`[inflator] Dictionary loaded — ${maxTokenId.toLocaleString()} tokens, ${(nodeBuf.byteLength / 1024).toFixed(0)} KB`);
}

// ─── Decode a single token id to a string ────────────────────────────────────
function decodeToken(tokenId: number): string {
  if (!offsets || !stringBlock || tokenId > maxTokenId) return `<${tokenId}>`;
  const start = offsets[tokenId];
  const end   = offsets[tokenId + 1];
  if (start >= end) return '';
  return textDecoder.decode(stringBlock.subarray(start, end), { stream: true });
}

// ─── Main stream runner ───────────────────────────────────────────────────────

/**
 * Connects to /ws/stream, streams binary token IDs, measures metrics.
 *
 * @param backend  e.g. 'http://localhost:8000'
 * @param prompt   The prompt to send
 * @param decode   If true, decodes token IDs via dictionary (measures full pipeline).
 *                 If false (headless), only counts bytes and tokens (pure wire speed).
 * @param cbs      Lifecycle callbacks
 */
export function runTokenWireStream(
  backend: string,
  prompt:  string,
  decode:  boolean,
  cbs:     InflatorCallbacks
): void {
  const wsUrl = backend.replace(/^http/, 'ws') + '/ws/stream';
  const ws    = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';    // same as browser inflator.worker.ts

  let tokensReceived = 0;
  let binaryBytes    = 0;
  let startTime      = 0;
  let ttft: number | null = null;
  const wallStart    = performance.now();

  ws.on('open', () => {
    startTime = performance.now();
    ws.send(JSON.stringify({ signal: 'START_STREAM', prompt }));
  });

  ws.on('message', (data: Buffer | ArrayBuffer) => {
    const now = performance.now();
    if (ttft === null) ttft = now - startTime;

    // ws gives us a Buffer in Node.js; convert to ArrayBuffer for DataView
    const buffer: ArrayBuffer =
      data instanceof Buffer
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
        : data as ArrayBuffer;

    const view = new DataView(buffer);
    let decoded = '';

    for (let i = 0; i < buffer.byteLength; i += 4) {
      const tokenId = view.getUint32(i, true);
      if (decode) {
        decoded += decodeToken(tokenId);
      }
      tokensReceived++;
    }

    binaryBytes += buffer.byteLength;

    const stats: StreamStats = {
      binaryBytes,
      tokens:  tokensReceived,
      ttft,
      tps:     tokensReceived / ((now - startTime) / 1000),
      totalMs: now - wallStart,
    };

    if (decode && cbs.onToken && decoded) {
      cbs.onToken(decoded, stats);
    }
  });

  ws.on('close', () => {
    const totalMs = performance.now() - wallStart;
    const tps     = tokensReceived / (totalMs / 1000);
    cbs.onDone({
      binaryBytes,
      tokens:  tokensReceived,
      ttft,
      tps,
      totalMs,
    });
  });

  ws.on('error', (err) => {
    console.error('[inflator] WebSocket error:', err.message);
    cbs.onDone({ binaryBytes, tokens: tokensReceived, ttft, tps: 0, totalMs: performance.now() - wallStart });
  });
}

/** Promise wrapper around runTokenWireStream for use with await. */
export function runTokenWireStreamAsync(
  backend: string,
  prompt:  string,
  decode:  boolean
): Promise<StreamStats> {
  return new Promise((resolve) =>
    runTokenWireStream(backend, prompt, decode, { onDone: resolve })
  );
}
