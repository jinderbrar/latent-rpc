# TokenWire

High-performance binary token streaming for local LLMs via client-side reconstruction.

## The Core Idea
Standard LLM streaming relies on heavy JSON/SSE envelopes that inflate network I/O. **TokenWire** bypasses this by streaming raw 32-bit token indices directly over WebSockets, performing instantaneous O(1) string reconstruction in the client's browser (or CLI) using a pre-mounted binary dictionary.

## Features
- **Binary Transport**: Massive reduction in payload size compared to JSON.
- **Client-Side Inflation**: Offloads text decoding to the edge.
- **Micro-Benchmark Suite**: Side-by-side comparison of TokenWire vs. Baseline JSON streaming.
- **V8 CLI Runner**: Headless benchmarking tool for accurate, DOM-less throughput measurement.

## Quickstart
1. **Backend**: `cd backend && pip install -r requirements.txt && uvicorn app.main:app --reload`
2. **Frontend**: `cd frontend && npm install && npm run dev`
3. **CLI Benchmark**: `cd scripts/node_benchmark && npm install && npx tsx cli.ts --dataset sample_1`
