#!/usr/bin/env node
/**
 * cli.ts — TokenWire Node.js V8 Benchmark CLI
 * =============================================
 *
 * Usage:
 *   npx tsx cli.ts [--dataset <id>] [--model <name>] [--decode] [--save <dir>] [--stdout <fmt>]
 *   npx tsx cli.ts --list-datasets
 *   npx tsx cli.ts --list-models
 *
 * Defaults:
 *   --dataset    required (use --list-datasets)
 *   --model      currently loaded model (no switch)
 *   --decode     false  (headless wire-speed only)
 *   --save       auto: reports/<timestamp>/
 *   --backend    http://localhost:8000
 *   --stdout     omit stdout-only output (always saves all formats)
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';

import { loadDictionary }             from './inflator.ts';
import { runBenchmark, listDatasets, listModels, loadModel } from './runner.ts';
import { formatTable, saveAllReports, formatJson, formatCsv, formatMarkdown } from './reporter.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── ANSI ─────────────────────────────────────────────────────────────────────
const A = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m' };
const c = (s: string, ...codes: string[]) => codes.join('') + s + A.reset;
const tick  = c('✓', A.green);
const cross = c('✗', A.red);
const arrow = c('→', A.cyan);

// ─── Arg parsing ──────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    'dataset':        { type: 'string',  default: '' },
    'model':          { type: 'string',  default: '' },
    'backend':        { type: 'string',  default: 'http://localhost:8000' },
    'decode':         { type: 'boolean', default: false },
    'save':           { type: 'string',  default: '' },
    'stdout':         { type: 'string',  default: '' },   // 'json' | 'csv' | 'markdown' | 'table'
    'list-datasets':  { type: 'boolean', default: false },
    'list-models':    { type: 'boolean', default: false },
    'help':           { type: 'boolean', default: false },
  },
  allowPositionals: false,
});

const BACKEND = (args['backend'] as string).replace(/\/$/, '');

// ─── Help ─────────────────────────────────────────────────────────────────────
if (args['help']) {
  console.log(`
${c('TokenWire Node.js V8 Benchmark', A.bold, A.cyan)}
${c('Runs the same inflator decode logic as the browser, but in bare Node.js V8.', A.dim)}

${c('Usage:', A.bold)}
  npx tsx cli.ts [options]

${c('Options:', A.bold)}
  --dataset <id>       Dataset ID to benchmark (required, see --list-datasets)
  --model <name>       Model to load (default: currently loaded model)
  --decode             Enable V8 token decode (measures full pipeline, default: headless)
  --save <dir>         Save all reports to <dir>/ (default: reports/<timestamp>/)
  --stdout <format>    Also print specific format: table | json | csv | markdown
  --backend <url>      Backend URL (default: http://localhost:8000)
  --list-datasets      List available datasets and exit
  --list-models        List available models and exit
  --help               Show this message

${c('Examples:', A.bold)}
  npx tsx cli.ts --list-datasets
  npx tsx cli.ts --dataset sample_1
  npx tsx cli.ts --dataset sample_1 --decode --stdout markdown
  npx tsx cli.ts --dataset sample_1 --model qwen2.5-coder:1.5b --save ./my-report
`);
  process.exit(0);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // List commands
  if (args['list-datasets']) {
    console.log(`\n${c('Available Datasets', A.bold)}\n`);
    const datasets = await listDatasets(BACKEND);
    if (datasets.length === 0) {
      console.log('  No datasets found. Add JSON files to backend/app/data/datasets/');
    }
    for (const d of datasets) {
      console.log(`  ${c(d.id, A.cyan)}  ${d.filename}  ${c(`(${d.prompt_count} prompts)`, A.dim)}`);
    }
    console.log();
    return;
  }

  if (args['list-models']) {
    console.log(`\n${c('Available Models', A.bold)}\n`);
    const models = await listModels(BACKEND);
    for (const m of models) console.log(`  ${c(m, A.cyan)}`);
    console.log();
    return;
  }

  // Validate dataset
  const datasetId = args['dataset'] as string;
  if (!datasetId) {
    console.error(`${cross} --dataset is required. Use --list-datasets to see available IDs.`);
    process.exit(1);
  }

  // Load model if specified
  const modelArg = args['model'] as string;
  if (modelArg) {
    process.stdout.write(`${arrow} Loading model ${c(modelArg, A.bold)}… `);
    try {
      await loadModel(BACKEND, modelArg);
      console.log(tick);
    } catch (e: unknown) {
      console.log(`${cross} ${(e as Error).message}`);
      process.exit(1);
    }
  }

  // Decode mode
  const decode   = args['decode'] as boolean;
  const modeStr  = decode ? 'full-decode (V8)' : 'headless (wire-speed)';

  // Pre-load dictionary in Node.js process (same binary as browser)
  if (decode) {
    process.stdout.write(`${arrow} Loading dictionary.bin… `);
    try {
      loadDictionary();
      console.log(tick);
    } catch (e: unknown) {
      console.log(`${cross} ${(e as Error).message}`);
      process.exit(1);
    }
  }

  console.log(`\n${c('TokenWire Node.js V8 Benchmark', A.bold, A.cyan)}`);
  console.log(`${c(`Dataset: ${datasetId}  |  Mode: ${modeStr}  |  Backend: ${BACKEND}`, A.dim)}\n`);

  // ── Run ──────────────────────────────────────────────────────────────────────
  const results = await runBenchmark(datasetId, {
    backend: BACKEND,
    decode,
    onProgress(current, total, result) {
      const b = result.baseline, t = result.tokenWire;
      const prompt = result.prompt.slice(0, 55) + (result.prompt.length > 55 ? '…' : '');
      console.log(`  ${c(`[${current}/${total}]`, A.dim)} ${prompt}`);
      console.log(`    ${c('baseline ', A.dim)}  TTFT ${b.ttft?.toFixed(0)}ms  TPS ${b.tps.toFixed(1)}  ${(b.payloadBytes/1024).toFixed(2)} KB  ${(b.totalMs/1000).toFixed(2)}s`);
      console.log(`    ${c('tokenWire', A.cyan)}  TTFT ${t.ttft?.toFixed(0)}ms  TPS ${t.tps.toFixed(1)}  ${(t.binaryBytes/1024).toFixed(2)} KB  ${(t.totalMs/1000).toFixed(2)}s  ${c(`-${result.savingsPct}%`, A.green)}`);
      console.log();
    },
  });

  // ── Print table to stdout ────────────────────────────────────────────────────
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const meta: Record<string, string> = {
    dataset:   datasetId,
    model:     modelArg || 'default',
    mode:      modeStr,
    timestamp: new Date().toISOString(),
    backend:   BACKEND,
    prompts:   String(results.length),
  };

  const stdoutFmt = (args['stdout'] as string).toLowerCase();

  if (!stdoutFmt || stdoutFmt === 'table') {
    console.log(formatTable(results, meta));
  } else if (stdoutFmt === 'json') {
    console.log(formatJson(results, meta));
  } else if (stdoutFmt === 'csv') {
    console.log(formatCsv(results, meta));
  } else if (stdoutFmt === 'markdown') {
    console.log(formatMarkdown(results, meta));
  }

  // ── Save all formats ─────────────────────────────────────────────────────────
  const saveBase  = (args['save'] as string) || path.join(__dirname, 'reports', timestamp);
  const { json, csv, md } = saveAllReports(results, meta, saveBase);

  console.log(`${tick} Reports saved to ${c(saveBase + '/', A.bold)}`);
  console.log(`   ${c('├─', A.dim)} ${c(json, A.dim)}`);
  console.log(`   ${c('├─', A.dim)} ${c(csv,  A.dim)}`);
  console.log(`   ${c('└─', A.dim)} ${c(md,   A.dim)}\n`);
}

main().catch(err => {
  console.error(`\n${cross} Fatal error:`, err.message ?? err);
  process.exit(1);
});
