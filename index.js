#!/usr/bin/env node
/**
 * type-coverage — Measure TypeScript type coverage.
 * Find every `any` lurking in your codebase.
 *
 * Zero external dependencies. Pure Node.js ES modules.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, relative, extname } from 'path';

// ─── ARGS ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function flag(name) { return args.includes(`--${name}`); }
function option(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

if (flag('help') || flag('h') || args.includes('-h')) {
  console.log(`
  type-coverage · Measure TypeScript type coverage

  Usage:
    npx type-coverage [options]

  Options:
    --threshold <n>      Exit 1 if coverage below N%
    --detail             Show every any usage with file + line
    --fix-hints          Suggest types for each any usage
    --ignore <pattern>   Ignore file glob pattern (e.g. "*.test.ts")
    --include <pattern>  Only analyse matching files
    --output <fmt>       Output format: text (default) | json | table
    --history            Compare with saved baseline
    --baseline           Save current coverage as baseline
    --help               Show this help

  Examples:
    npx type-coverage
    npx type-coverage --threshold 80
    npx type-coverage --detail --fix-hints
    npx type-coverage --output json
    npx type-coverage --baseline
    npx type-coverage --history
  `);
  process.exit(0);
}

const THRESHOLD    = option('threshold') ? parseFloat(option('threshold')) : null;
const DETAIL       = flag('detail');
const FIX_HINTS    = flag('fix-hints');
const IGNORE_PAT   = option('ignore');
const INCLUDE_PAT  = option('include');
const OUTPUT_FMT   = option('output') || 'text';
const SHOW_HISTORY = flag('history');
const SAVE_BASELINE = flag('baseline');

const BASELINE_FILE = '.type-coverage.json';

// ─── FILE WALKING ─────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set(['node_modules','dist','build','.git','coverage','.next','out','.nuxt']);

function walkDir(dir, files = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return files; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const fullPath = join(dir, entry);
    let stat;
    try { stat = statSync(fullPath); } catch { continue; }
    if (stat.isDirectory()) {
      walkDir(fullPath, files);
    } else {
      const ext = extname(entry);
      if (ext === '.ts' || ext === '.tsx') files.push(fullPath);
    }
  }
  return files;
}

function matchesPattern(filePath, pattern) {
  if (!pattern) return false;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(escaped).test(filePath);
}

// ─── ANALYSIS ─────────────────────────────────────────────────────────────────

const ANY_PATTERNS = [
  { regex: /:\s*any(?=\s*[;,)\]|&{=\n])/g,    kind: 'explicit `: any`' },
  { regex: /\bas\s+any(?=\s*[;,)\]|&{=\n])/g, kind: '`as any` cast'   },
  { regex: /<any>/g,                            kind: '`<any>` cast'    },
  { regex: /:\s*any\[\]/g,                      kind: '`any[]` array'   },
  { regex: /=>\s*any(?=\s*[;,{\n])/g,          kind: '`=> any` return' },
  { regex: /Promise<any>/g,                     kind: '`Promise<any>`'  },
];

const TYPED_PATTERNS = [
  /:\s*string(?=\s*[;,)\]|&{=\n])/g,
  /:\s*number(?=\s*[;,)\]|&{=\n])/g,
  /:\s*boolean(?=\s*[;,)\]|&{=\n])/g,
  /:\s*void(?=\s*[;,)\]|&{=\n])/g,
  /:\s*never(?=\s*[;,)\]|&{=\n])/g,
  /:\s*unknown(?=\s*[;,)\]|&{=\n])/g,
  /:\s*null(?=\s*[;,)\]|&{=\n])/g,
  /:\s*undefined(?=\s*[;,)\]|&{=\n])/g,
  /:\s*object(?=\s*[;,)\]|&{=\n])/g,
  /:\s*[A-Z][A-Za-z0-9_<>,\[\] ]+(?=\s*[;,)\]|&{=\n])/g,
  /interface\s+\w+/g,
  /type\s+\w+\s*=/g,
  /enum\s+\w+/g,
];

function stripComments(src) {
  return src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

function countMatches(text, regex) {
  const r = new RegExp(regex.source, 'g');
  return (text.match(r) || []).length;
}

function getMatchLocations(text, regex, lines) {
  const r = new RegExp(regex.source, 'g');
  const locations = [];
  let m;
  while ((m = r.exec(text)) !== null) {
    const before = text.slice(0, m.index);
    const lineNo = before.split('\n').length;
    locations.push({
      line: lineNo,
      match: m[0].trim(),
      context: (lines[lineNo - 1] || '').trim(),
    });
  }
  return locations;
}

function countImplicitAny(text) {
  // Count function params missing type annotations
  const r = /(?:function\s+\w*|(?:async\s+)?\w+)\s*\(([^)]{0,200})\)\s*(?::|{|=>)/g;
  let count = 0;
  let m;
  while ((m = r.exec(text)) !== null) {
    const params = m[1];
    if (!params.trim()) continue;
    for (const param of params.split(',').map(p => p.trim()).filter(Boolean)) {
      const cleaned = param.replace(/^\.\.\./, '').trim();
      if (!cleaned) continue;
      if (cleaned.includes(':')) continue;
      if (cleaned.startsWith('{') || cleaned.startsWith('[')) continue;
      if (cleaned.includes('=') && cleaned.split('=')[0].trim().includes(':')) continue;
      count++;
    }
  }
  return count;
}

function analyseFile(filePath) {
  let src;
  try { src = readFileSync(filePath, 'utf8'); } catch { return null; }

  const stripped = stripComments(src);
  const lines = src.split('\n');

  let anyCount = 0;
  const breakdown = {};
  const locations = [];

  for (const { regex, kind } of ANY_PATTERNS) {
    const locs = getMatchLocations(stripped, regex, lines);
    breakdown[kind] = (breakdown[kind] || 0) + locs.length;
    anyCount += locs.length;
    for (const loc of locs) locations.push({ ...loc, kind, file: filePath });
  }

  const implicitCount = countImplicitAny(stripped);
  breakdown['untyped params'] = implicitCount;
  anyCount += implicitCount;

  let typedCount = 0;
  for (const pat of TYPED_PATTERNS) typedCount += countMatches(stripped, pat);

  const total = typedCount + anyCount;
  const coverage = total === 0 ? 100 : (typedCount / total) * 100;

  return { file: filePath, anyCount, typedCount, total, coverage, breakdown, locations };
}

// ─── FIX HINTS ────────────────────────────────────────────────────────────────

const HINT_RULES = [
  { pattern: /\b(err|error|e)\b/i,              hint: 'Error | unknown'              },
  { pattern: /\b(data|result|response|res)\b/i,  hint: 'unknown'                     },
  { pattern: /\b(event|evt|ev)\b/i,              hint: 'Event'                       },
  { pattern: /\b(node|el|element)\b/i,           hint: 'HTMLElement | null'          },
  { pattern: /\b(value|val)\b/i,                 hint: 'string | number | boolean'   },
  { pattern: /\b(config|options|opts)\b/i,       hint: 'Record<string, unknown>'     },
  { pattern: /\b(items|list|arr|array)\b/i,      hint: 'unknown[]'                   },
  { pattern: /\b(map|dict|obj)\b/i,              hint: 'Record<string, unknown>'     },
  { pattern: /\b(fn|func|callback|cb)\b/i,       hint: '(...args: unknown[]) => void'},
  { pattern: /\b(id)\b/i,                        hint: 'string | number'             },
];

function getFixHint(location) {
  const ctx = location.context + ' ' + location.match;
  for (const { pattern, hint } of HINT_RULES) {
    if (pattern.test(ctx)) return hint;
  }
  return 'unknown';
}

// ─── RENDER ───────────────────────────────────────────────────────────────────

const R = '\x1b[0m', BOLD = '\x1b[1m', DIM = '\x1b[2m';
const GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RED = '\x1b[31m', CYAN = '\x1b[36m';

function colorCoverage(pct) {
  if (pct >= 90) return GREEN;
  if (pct >= 70) return YELLOW;
  return RED;
}

function progressBar(pct, width = 20) {
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function pad(str, len, right = false) {
  const s = String(str);
  return right ? s.padStart(len) : s.padEnd(len);
}

function renderText(results, allLocations, stats, baseline) {
  const { files, anyCount, typedCount, total, coverage, breakdown } = stats;
  const col = colorCoverage(coverage);
  const sep = `${DIM}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${R}`;

  console.log();
  console.log(`  ${BOLD}type-coverage${R} · ${CYAN}${files}${R} TypeScript file${files !== 1 ? 's' : ''}`);
  console.log(sep);
  console.log();

  const trend = baseline ? (coverage - baseline.coverage) : null;
  const trendStr = trend !== null
    ? (trend >= 0 ? ` ${GREEN}▲ +${trend.toFixed(1)}%${R}` : ` ${RED}▼ ${trend.toFixed(1)}%${R}`)
    : '';

  console.log(`  Overall coverage: ${col}${BOLD}${coverage.toFixed(1)}%${R}  ${col}${progressBar(coverage)}${R}${trendStr}`);
  console.log();

  const worst = [...results]
    .filter(r => r.anyCount > 0)
    .sort((a, b) => a.coverage - b.coverage)
    .slice(0, 10);

  if (worst.length > 0) {
    console.log(`  ${BOLD}Worst files:${R}`);
    for (const r of worst) {
      const rel = relative(process.cwd(), r.file);
      const c = colorCoverage(r.coverage);
      console.log(
        `  ${pad(rel, 40)}${c}${pad(r.coverage.toFixed(1) + '%', 8, true)}${R}  ` +
        `${c}${progressBar(r.coverage)}${R}  ${DIM}${r.anyCount} any${R}`
      );
    }
    console.log();
  }

  console.log(`  ${BOLD}any breakdown:${R}`);
  for (const [kind, count] of Object.entries(breakdown)) {
    if (count > 0) console.log(`  ${pad(kind, 26)}${RED}${pad(count, 4, true)}${R}`);
  }
  console.log();
  console.log(sep);

  const top10 = allLocations.filter(l => l.kind !== 'untyped params').slice(0, 10);
  if (top10.length > 0 && !DETAIL) {
    console.log(`  ${BOLD}Top any locations:${R}`);
    for (const loc of top10) {
      const rel = relative(process.cwd(), loc.file);
      const hint = FIX_HINTS ? `  ${CYAN}→ ${getFixHint(loc)}${R}` : '';
      console.log(`  ${DIM}${rel}:${loc.line}${R}  ${loc.context.slice(0, 60)}${hint}`);
    }
    console.log();
    console.log(sep);
  }

  if (DETAIL) {
    console.log(`\n  ${BOLD}All any usages:${R}`);
    const byFile = {};
    for (const loc of allLocations) {
      const rel = relative(process.cwd(), loc.file);
      (byFile[rel] = byFile[rel] || []).push(loc);
    }
    for (const [file, locs] of Object.entries(byFile)) {
      console.log(`\n  ${BOLD}${file}${R}`);
      for (const loc of locs) {
        const hint = FIX_HINTS ? `  ${CYAN}→ ${getFixHint(loc)}${R}` : '';
        console.log(`    ${DIM}:${loc.line}${R}  ${loc.kind}  ${DIM}${loc.context.slice(0, 60)}${R}${hint}`);
      }
    }
    console.log();
    console.log(sep);
  }

  const threshStr = THRESHOLD !== null
    ? (coverage >= THRESHOLD
        ? `  ${GREEN}✓ threshold ${THRESHOLD}% met${R}`
        : `  ${RED}✗ below threshold ${THRESHOLD}%${R}`)
    : '';
  console.log(`\n  ${col}${BOLD}${coverage.toFixed(1)}%${R} coverage · ${RED}${anyCount} any${R} · Run with ${DIM}--detail${R} for locations${threshStr}`);
  console.log();
}

function renderTable(results) {
  const rows = results
    .sort((a, b) => a.coverage - b.coverage)
    .map(r => ({
      File: relative(process.cwd(), r.file),
      'Coverage %': r.coverage.toFixed(1) + '%',
      'Any': r.anyCount,
      'Typed': r.typedCount,
      'Total': r.total,
    }));
  if (rows.length === 0) { console.log('No TypeScript files found.'); return; }
  const cols = Object.keys(rows[0]);
  const widths = cols.map(c => Math.max(c.length, ...rows.map(r => String(r[c]).length)));
  const line = widths.map(w => '─'.repeat(w + 2)).join('┼');
  console.log('┌' + widths.map(w => '─'.repeat(w + 2)).join('┬') + '┐');
  console.log('│' + cols.map((c, i) => ` ${pad(c, widths[i])} `).join('│') + '│');
  console.log('├' + line + '┤');
  for (const row of rows) {
    console.log('│' + cols.map((c, i) => ` ${pad(String(row[c]), widths[i])} `).join('│') + '│');
  }
  console.log('└' + widths.map(w => '─'.repeat(w + 2)).join('┴') + '┘');
}

function renderJson(stats, results, allLocations, baseline) {
  const out = {
    coverage: parseFloat(stats.coverage.toFixed(2)),
    files: stats.files,
    anyCount: stats.anyCount,
    typedCount: stats.typedCount,
    total: stats.total,
    breakdown: stats.breakdown,
    baseline: baseline ? { coverage: baseline.coverage, date: baseline.date } : null,
    trend: baseline ? parseFloat((stats.coverage - baseline.coverage).toFixed(2)) : null,
    results: results.map(r => ({
      file: relative(process.cwd(), r.file),
      coverage: parseFloat(r.coverage.toFixed(2)),
      anyCount: r.anyCount,
      typedCount: r.typedCount,
      breakdown: r.breakdown,
    })),
    ...(DETAIL ? {
      locations: allLocations.map(l => ({
        file: relative(process.cwd(), l.file),
        line: l.line,
        kind: l.kind,
        context: l.context,
        ...(FIX_HINTS ? { hint: getFixHint(l) } : {}),
      }))
    } : {}),
  };
  console.log(JSON.stringify(out, null, 2));
}

// ─── BASELINE ─────────────────────────────────────────────────────────────────

function loadBaseline() {
  const path = join(process.cwd(), BASELINE_FILE);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function saveBaseline(stats) {
  const path = join(process.cwd(), BASELINE_FILE);
  writeFileSync(path, JSON.stringify({
    coverage: parseFloat(stats.coverage.toFixed(2)),
    anyCount: stats.anyCount,
    typedCount: stats.typedCount,
    total: stats.total,
    files: stats.files,
    date: new Date().toISOString(),
  }, null, 2), 'utf8');
  console.log(`\n  \x1b[32m✓ Baseline saved to ${BASELINE_FILE}\x1b[0m\n`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

function main() {
  const cwd = process.cwd();
  let files = walkDir(cwd);

  if (IGNORE_PAT) files = files.filter(f => !matchesPattern(relative(cwd, f), IGNORE_PAT));
  if (INCLUDE_PAT) files = files.filter(f => matchesPattern(relative(cwd, f), INCLUDE_PAT));

  if (files.length === 0) {
    console.error('  No TypeScript files found.');
    process.exit(0);
  }

  const results = files.map(analyseFile).filter(Boolean);
  const totalAny   = results.reduce((s, r) => s + r.anyCount, 0);
  const totalTyped = results.reduce((s, r) => s + r.typedCount, 0);
  const totalNodes = totalAny + totalTyped;
  const coverage   = totalNodes === 0 ? 100 : (totalTyped / totalNodes) * 100;

  const breakdown = {};
  for (const r of results) {
    for (const [k, v] of Object.entries(r.breakdown)) {
      breakdown[k] = (breakdown[k] || 0) + v;
    }
  }

  const allLocations = results
    .flatMap(r => r.locations)
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const stats = { files: results.length, anyCount: totalAny, typedCount: totalTyped, total: totalNodes, coverage, breakdown };

  const baseline = (SHOW_HISTORY || !SAVE_BASELINE) ? loadBaseline() : null;

  if (SAVE_BASELINE) {
    saveBaseline(stats);
    if (OUTPUT_FMT === 'text') return;
  }

  switch (OUTPUT_FMT) {
    case 'json':  renderJson(stats, results, allLocations, baseline); break;
    case 'table': renderTable(results); break;
    default:      renderText(results, allLocations, stats, SHOW_HISTORY ? baseline : null);
  }

  if (THRESHOLD !== null && coverage < THRESHOLD) process.exit(1);
}

main();
