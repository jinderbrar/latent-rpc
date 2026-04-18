/**
 * runner.ts
 * ---------
 * Orchestrates the full benchmark run.
 * For each prompt: baseline → tokenWire (sequential, with optional cache clear).
 * Port of the `startBenchmark` loop from ResearchPortal.tsx.
 */

import { runTokenWireStreamAsync, type StreamStats } from './inflator.ts';
import { runBaselineStreamAsync, type BaselineStats } from './baseline_stream.ts';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PromptMeta {
  id:       string;
  category: string;
  prompt:   string;
}

export interface PromptResult {
  promptId:  string;
  category:  string;
  prompt:    string;
  baseline:  BaselineStats;
  tokenWire:    StreamStats;
  savingsPct: number;
}

export interface RunnerOptions {
  backend:     string;  // e.g. 'http://localhost:8000'
  decode:      boolean; // true = full V8 decode; false = headless wire-speed only
  onProgress?: (current: number, total: number, result: PromptResult) => void;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function httpGet<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json() as Promise<T>;
}

async function httpPost(url: string, body?: unknown): Promise<void> {
  await fetch(url, {
    method:  'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body:    body ? JSON.stringify(body) : undefined,
  }).catch(() => {}); // Non-fatal
}

export async function listDatasets(backend: string): Promise<Array<{ id: string; filename: string; prompt_count: number }>> {
  const data = await httpGet<{ datasets: Array<{ id: string; filename: string; prompt_count: number }> }>(
    `${backend}/api/research/datasets`
  );
  return data.datasets;
}

export async function listModels(backend: string): Promise<string[]> {
  const data = await httpGet<{ models: string[] }>(`${backend}/api/research/models`);
  return data.models;
}

export async function loadModel(backend: string, modelId: string): Promise<void> {
  const res = await fetch(`${backend}/api/research/model/load`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ model_id: modelId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to load model: ${text}`);
  }
}

async function getPrompts(backend: string, datasetId: string): Promise<PromptMeta[]> {
  const data = await httpGet<{ prompts: PromptMeta[] }>(
    `${backend}/api/research/datasets/${datasetId}/prompts`
  );
  return data.prompts;
}

// ─── Main runner ──────────────────────────────────────────────────────────────

export async function runBenchmark(
  datasetId: string,
  opts:      RunnerOptions
): Promise<PromptResult[]> {
  const { backend, decode, onProgress } = opts;

  const prompts = await getPrompts(backend, datasetId);
  const results: PromptResult[] = [];

  for (let i = 0; i < prompts.length; i++) {
    const p = prompts[i];

    // Baseline — dedicated instance, but we still clear to be safe for the
    // very first run (subsequent runs are already clean due to dual instances).
    // With dual instances this is a no-op in practice.
    await httpPost(`${backend}/api/research/cache/clear`);
    const baseline = await runBaselineStreamAsync(backend, p.prompt);

    // TokenWire — independent KV cache, no cross-contamination from baseline
    await httpPost(`${backend}/api/research/cache/clear`);
    const tokenWire = await runTokenWireStreamAsync(backend, p.prompt, decode);

    const savingsPct = baseline.payloadBytes > 0
      ? parseFloat(((1 - tokenWire.binaryBytes / baseline.payloadBytes) * 100).toFixed(1))
      : 0;

    const result: PromptResult = {
      promptId:   p.id,
      category:   p.category,
      prompt:     p.prompt,
      baseline,
      tokenWire,
      savingsPct,
    };

    results.push(result);
    onProgress?.(i + 1, prompts.length, result);
  }

  return results;
}
