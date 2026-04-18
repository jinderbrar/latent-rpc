/**
 * reporter.ts
 * -----------
 * All report output formats: table, JSON, CSV, Markdown.
 * Generates all formats by default; CLI can request specific ones.
 */

import fs   from 'fs';
import path from 'path';
import type { PromptResult } from './runner.ts';

// ─── ANSI ─────────────────────────────────────────────────────────────────────
const A = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  white:  '\x1b[37m',
  purple: '\x1b[35m',
};
const c = (s: string, ...codes: string[]) => codes.join('') + s + A.reset;

// ─── Formatters ───────────────────────────────────────────────────────────────
const fmtMs  = (v: number | null) => v != null ? `${v.toFixed(0)}ms`  : '—';
const fmtTps = (v: number)        => v.toFixed(1);
const fmtKb  = (b: number)        => `${(b / 1024).toFixed(2)} KB`;
const fmtSec = (ms: number)       => `${(ms / 1000).toFixed(2)}s`;

// ─── Summary computation ──────────────────────────────────────────────────────
function avg(arr: number[]) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

interface Summary {
  avgBaselineTps:   number;
  avgTokenWireTps:     number;
  avgBaselineTtft:  number;
  avgTokenWireTtft:    number;
  avgBaselineKb:    number;
  avgTokenWireKb:      number;
  avgSavingsPct:    number;
}

function computeSummary(results: PromptResult[]): Summary {
  return {
    avgBaselineTps:  avg(results.map(r => r.baseline.tps)),
    avgTokenWireTps:    avg(results.map(r => r.tokenWire.tps)),
    avgBaselineTtft: avg(results.filter(r => r.baseline.ttft != null).map(r => r.baseline.ttft!)),
    avgTokenWireTtft:   avg(results.filter(r => r.tokenWire.ttft != null).map(r => r.tokenWire.ttft!)),
    avgBaselineKb:   avg(results.map(r => r.baseline.payloadBytes / 1024)),
    avgTokenWireKb:     avg(results.map(r => r.tokenWire.binaryBytes    / 1024)),
    avgSavingsPct:   avg(results.map(r => r.savingsPct)),
  };
}

// ─── TABLE ────────────────────────────────────────────────────────────────────

export function formatTable(results: PromptResult[], meta: Record<string, string>): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(c('  TokenWire V8 Benchmark Report', A.bold, A.cyan));
  lines.push(c(`  Dataset: ${meta.dataset}  |  Model: ${meta.model}  |  Mode: ${meta.mode}  |  ${meta.timestamp}`, A.dim));
  lines.push('');

  const W = [44, 14, 10, 10, 12, 10, 8];
  const HEADERS = ['Prompt', 'Protocol', 'TTFT', 'TPS', 'Payload', 'Time', 'Tokens'];
  const SEP = '+' + W.map(w => '-'.repeat(w + 2)).join('+') + '+';
  const row = (cells: string[], colour?: string) => {
    const r = '|' + cells.map((cell, i) => ` ${cell.padEnd(W[i])} `).join('|') + '|';
    return colour ? c(r, colour) : r;
  };

  lines.push(SEP);
  lines.push(row(HEADERS, A.bold));
  lines.push(SEP.replace(/-/g, '='));

  for (const r of results) {
    const prompt = r.prompt.length > 42 ? r.prompt.slice(0, 42) + '…' : r.prompt;
    const b = r.baseline, t = r.tokenWire;

    // Baseline row
    lines.push(row([
      prompt,
      'JSON Baseline',
      fmtMs(b.ttft),
      fmtTps(b.tps),
      fmtKb(b.payloadBytes),
      fmtSec(b.totalMs),
      String(b.tokens),
    ]));

    // TokenWire row
    lines.push(c(row([
      '',
      'TokenWire',
      fmtMs(t.ttft),
      fmtTps(t.tps),
      `${fmtKb(t.binaryBytes)} (-${r.savingsPct}%)`,
      fmtSec(t.totalMs),
      String(t.tokens),
    ]), A.cyan));

    lines.push(SEP);
  }

  // Summary
  const s = computeSummary(results);
  lines.push('');
  lines.push(c('  Averages', A.bold));
  lines.push(`  ${'Avg TPS'.padEnd(14)}  Baseline: ${c(fmtTps(s.avgBaselineTps), A.white)}   TokenWire: ${c(fmtTps(s.avgTokenWireTps), A.cyan)}`);
  lines.push(`  ${'Avg TTFT'.padEnd(14)}  Baseline: ${c(fmtMs(s.avgBaselineTtft), A.white)}   TokenWire: ${c(fmtMs(s.avgTokenWireTtft), A.cyan)}`);
  lines.push(`  ${'Avg Payload'.padEnd(14)}  Baseline: ${c(fmtKb(s.avgBaselineKb * 1024), A.white)}   TokenWire: ${c(fmtKb(s.avgTokenWireKb * 1024), A.cyan)}`);
  lines.push(`  ${'Avg Savings'.padEnd(14)}  ${c(`-${s.avgSavingsPct.toFixed(1)}%`, A.green)}`);
  lines.push('');

  return lines.join('\n');
}

// ─── JSON ─────────────────────────────────────────────────────────────────────

export function formatJson(results: PromptResult[], meta: Record<string, string>): string {
  return JSON.stringify(
    {
      meta,
      summary: computeSummary(results),
      results: results.map(r => ({
        prompt_id:   r.promptId,
        category:    r.category,
        prompt:      r.prompt,
        savings_pct: r.savingsPct,
        baseline: {
          payload_bytes: r.baseline.payloadBytes,
          payload_kb:    parseFloat(fmtKb(r.baseline.payloadBytes)),
          tokens:        r.baseline.tokens,
          ttft_ms:       r.baseline.ttft != null ? parseFloat(r.baseline.ttft.toFixed(1)) : null,
          tps:           parseFloat(fmtTps(r.baseline.tps)),
          total_ms:      parseFloat(r.baseline.totalMs.toFixed(1)),
        },
        tokenWire: {
          payload_bytes: r.tokenWire.binaryBytes,
          payload_kb:    parseFloat(fmtKb(r.tokenWire.binaryBytes)),
          tokens:        r.tokenWire.tokens,
          ttft_ms:       r.tokenWire.ttft != null ? parseFloat(r.tokenWire.ttft.toFixed(1)) : null,
          tps:           parseFloat(fmtTps(r.tokenWire.tps)),
          total_ms:      parseFloat(r.tokenWire.totalMs.toFixed(1)),
        },
      })),
    },
    null,
    2
  );
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

export function formatCsv(results: PromptResult[], _meta: Record<string, string>): string {
  const FIELDS = [
    'prompt_id', 'category', 'prompt',
    'baseline_ttft_ms', 'baseline_tps', 'baseline_kb', 'baseline_total_ms', 'baseline_tokens',
    'tokenWire_ttft_ms',   'tokenWire_tps',   'tokenWire_kb',   'tokenWire_total_ms',   'tokenWire_tokens',
    'savings_pct',
  ];

  const escape = (v: unknown) => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  const rows = [FIELDS.join(',')];
  for (const r of results) {
    const b = r.baseline, t = r.tokenWire;
    rows.push([
      r.promptId,
      r.category,
      r.prompt,
      b.ttft?.toFixed(1) ?? '',
      b.tps.toFixed(2),
      (b.payloadBytes / 1024).toFixed(2),
      b.totalMs.toFixed(1),
      b.tokens,
      t.ttft?.toFixed(1) ?? '',
      t.tps.toFixed(2),
      (t.binaryBytes / 1024).toFixed(2),
      t.totalMs.toFixed(1),
      t.tokens,
      r.savingsPct,
    ].map(escape).join(','));
  }

  return rows.join('\n');
}

// ─── Markdown ─────────────────────────────────────────────────────────────────

export function formatMarkdown(results: PromptResult[], meta: Record<string, string>): string {
  const lines: string[] = [];

  lines.push('# TokenWire V8 Benchmark Report');
  lines.push('');
  lines.push(`**Dataset:** \`${meta.dataset}\` | **Model:** \`${meta.model}\` | **Mode:** \`${meta.mode}\` | **Run:** ${meta.timestamp}`);
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push('| Prompt | Protocol | TTFT | TPS | Payload | Total Time | Tokens | Δ Size |');
  lines.push('|--------|----------|------|-----|---------|------------|--------|--------|');

  for (const r of results) {
    const p = r.prompt.length > 50 ? r.prompt.slice(0, 50) + '…' : r.prompt;
    const b = r.baseline, t = r.tokenWire;
    lines.push(`| ${p} | JSON Baseline | ${fmtMs(b.ttft)} | ${fmtTps(b.tps)} | ${fmtKb(b.payloadBytes)} | ${fmtSec(b.totalMs)} | ${b.tokens} | — |`);
    lines.push(`| | **TokenWire** | ${fmtMs(t.ttft)} | **${fmtTps(t.tps)}** | **${fmtKb(t.binaryBytes)}** | ${fmtSec(t.totalMs)} | ${t.tokens} | **-${r.savingsPct}%** |`);
  }

  const s = computeSummary(results);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | JSON Baseline | TokenWire |');
  lines.push('|--------|--------------|------------|');
  lines.push(`| Avg TPS     | ${fmtTps(s.avgBaselineTps)}  | ${fmtTps(s.avgTokenWireTps)} |`);
  lines.push(`| Avg TTFT    | ${fmtMs(s.avgBaselineTtft)} | ${fmtMs(s.avgTokenWireTtft)} |`);
  lines.push(`| Avg Payload | ${fmtKb(s.avgBaselineKb * 1024)} | ${fmtKb(s.avgTokenWireKb * 1024)} |`);
  lines.push(`| Avg Savings | — | **-${s.avgSavingsPct.toFixed(1)}%** |`);
  lines.push('');
  lines.push('---');
  lines.push('*Generated by TokenWire Node.js V8 Benchmark Runner*');

  return lines.join('\n');
}

// ─── Save all formats to a directory ─────────────────────────────────────────

export function saveAllReports(
  results:  PromptResult[],
  meta:     Record<string, string>,
  saveDir:  string
): { json: string; csv: string; md: string } {
  fs.mkdirSync(saveDir, { recursive: true });

  const jsonPath = path.join(saveDir, 'report.json');
  const csvPath  = path.join(saveDir, 'report.csv');
  const mdPath   = path.join(saveDir, 'report.md');

  fs.writeFileSync(jsonPath, formatJson(results, meta),     'utf-8');
  fs.writeFileSync(csvPath,  formatCsv(results, meta),      'utf-8');
  fs.writeFileSync(mdPath,   formatMarkdown(results, meta), 'utf-8');

  return { json: jsonPath, csv: csvPath, md: mdPath };
}
