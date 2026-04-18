// Flat Binary Memory Maps
let offsets: Uint32Array | null = null;
let stringBlock: Uint8Array | null = null;
let maxTokenId = 0;
const textDecoder = new TextDecoder("utf-8");

// Telemetry State
let tokensReceived = 0;
let startTime = 0;
let ttft: number | null = null;
let lastBytesArray: number = 0;

let socket: WebSocket | null = null;
let isHeadless = false;
let lastKnownStats: any = null;

// Session ID to prevent stale socket STREAM_DONE from racing with new prompts
let currentSessionId = 0;

async function loadDictionary() {
  console.log("Fetching binary dictionary block...");
  try {
    const res = await fetch('/dictionary.bin');
    if (!res.ok) throw new Error("Failed to fetch dictionary.bin");
    const buffer = await res.arrayBuffer();

    // Check Header (Magic number + MaxTokenId)
    const magic = textDecoder.decode(new Uint8Array(buffer, 0, 4));
    if (magic !== 'LRPC') throw new Error("Invalid dictionary magic marker: " + magic);

    const view = new DataView(buffer);
    maxTokenId = view.getUint32(4, true); // true = little-endian

    const offsetCount = maxTokenId + 2;
    const offsetsByteLength = offsetCount * 4;

    // 8 bytes in: safely aligned to 4-byte boundaries for Uint32Array
    offsets = new Uint32Array(buffer, 8, offsetCount);

    const stringsStart = 8 + offsetsByteLength;
    stringBlock = new Uint8Array(buffer, stringsStart);

    console.log(`Successfully mapped binary dictionary. Max Token ID: ${maxTokenId}`);
  } catch (err) {
    console.error("Binary Dictionary Mount Failed:", err);
  }
  postMessage({ type: 'INITIALIZED' });
}

// Websocket Handling
function connectWebSocket(prompt: string) {
  // Capture session ID in closure — stale sockets skip their callbacks
  const mySessionId = ++currentSessionId;

  if (socket) socket.close();

  socket = new WebSocket('ws://localhost:8000/ws/stream');
  socket.binaryType = 'arraybuffer';

  socket.onopen = () => {
    // Only proceed if this is still the current session
    if (mySessionId !== currentSessionId) return;

    startTime = performance.now();
    tokensReceived = 0;
    lastBytesArray = 0;
    ttft = null;

    // Send control message natively as JSON (Text Frame)
    socket!.send(JSON.stringify({
      signal: "START_STREAM",
      prompt: prompt
    }));
  };

  socket.onmessage = async (e) => {
    const now = performance.now();
    if (ttft === null) ttft = now - startTime;

    if (mySessionId !== currentSessionId) return; // stale – discard
    const buffer = e.data;
    const view = new DataView(buffer);

    let finalRenderStr = "";

    // Array buffer can contain 1 to N tokens. Loop 4 bytes at a time
    for (let i = 0; i < buffer.byteLength; i += 4) {
      if (!isHeadless) {
        const currentTokenId = view.getUint32(i, true);

        // Instantaneous O(1) Binary Offset Tuple lookup
        if (offsets && stringBlock && currentTokenId <= maxTokenId) {
          const start = offsets[currentTokenId];
          const end = offsets[currentTokenId + 1];
          if (start < end) {
            const slice = stringBlock.subarray(start, end);
            finalRenderStr += textDecoder.decode(slice, { stream: true });
          }
        } else {
          finalRenderStr += ` <${currentTokenId}> `;
        }
      }
      tokensReceived++;
    }

    const binarySize = buffer.byteLength;
    lastBytesArray += binarySize;

    const tps = tokensReceived / ((now - startTime) / 1000);

    lastKnownStats = {
      binaryBytes: lastBytesArray,
      tps: tps,
      tokens: tokensReceived,
      ttft: ttft,
      totalMs: now - startTime
    };

    if (!isHeadless) {
      postMessage({
        type: 'TOKEN_DECODED',
        text: finalRenderStr,
        stats: lastKnownStats
      });
    }
  };

  socket.onclose = () => {
    if (mySessionId !== currentSessionId) return; // stale socket
    postMessage({ type: 'STREAM_DONE', stats: lastKnownStats });
  };

  socket.onerror = (e) => {
    if (mySessionId !== currentSessionId) return;
    console.error("TokenWire socket error", e);
    postMessage({ type: 'STREAM_DONE', stats: lastKnownStats });
  };
}

self.onmessage = async (e) => {
  if (e.data.type === 'INIT_DICTIONARY') {
    await loadDictionary();
  } else if (e.data.type === 'START_STREAM') {
    isHeadless = e.data.headless || false;
    connectWebSocket(e.data.prompt);
  }
};
