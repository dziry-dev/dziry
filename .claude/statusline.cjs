#!/usr/bin/env node
'use strict';

/**
 * Claude Code statusline renderer — reads the session JSON from stdin, writes ANSI
 * lines to stdout.
 *
 * Self-contained on purpose: no `.ck.json`, no `hooks/lib` imports, no hook-populated
 * caches. Everything it needs is either in the stdin payload or shelled out to `git`.
 * Adapted from the book-maker renderer, which sourced its layout from a config file and
 * three hook-written caches; the layout here is the CONFIG block below, and the features
 * that depended on those caches are gone rather than silently rendering empty:
 *
 *   - quota windows (5h / weekly) needed a hook to poll and cache the usage API
 *   - active plan needed hook-written session state
 *   - agent / todo rows needed a transcript parser fed by PostToolUse hooks
 *
 * Output for the sections that remain is byte-identical to the original defaults.
 */

const { stdin, env } = require('process');
const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ============================================================================
// CONFIG — edit here; there is no config file
// ============================================================================

const CONFIG = {
  /** 'full' | 'compact' | 'minimal' | 'none' */
  mode: 'full',

  /** false forces plain text. NO_COLOR in the environment always wins over this. */
  colors: true,

  /** Sections wrap to a new line past this fraction of terminal width. */
  responsiveBreakpoint: 0.85,

  /** Cost is off by default — it is noise unless you are watching spend. */
  sections: {
    model: true,
    context: true,
    directory: true,
    git: true,
    cost: false,
    changes: true,
  },

  icons: {
    model: '🤖',
    directory: '📁',
    git: '🌿',
    cost: '💰',
    changes: '📝',
    /** minimal mode swaps the bar for this */
    battery: '🔋',
  },

  /** Any key of COLOR_CODES below, or 'none' for uncolored. */
  sectionColors: {
    model: 'cyan',
    directory: 'yellow',
    git: 'magenta',
    cost: 'dim',
  },

  context: {
    barWidth: 12,
    low: 'green',
    mid: 'yellow',
    high: 'red',
    /** percentage thresholds at which mid / high colors kick in */
    midAt: 70,
    highAt: 85,
  },

  git: {
    /** How long a git result is reused. Nothing invalidates this early, so keep it short. */
    cacheTtlMs: 30000,
    /** Guards against hanging on a network-mounted or huge repo. */
    timeoutMs: 3000,
  },

  /**
   * Claude Code starts auto-compacting before the window is literally full, so the
   * honest "used" figure includes this headroom.
   */
  autocompactBuffer: 40000,
};

// ============================================================================
// COLOR
// ============================================================================

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const CLEAR_INTENSITY = '\x1b[22m';
const CLEAR_FOREGROUND = '\x1b[39m';

const COLOR_CODES = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  dim: DIM,
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
};

/**
 * Every colored span is bracketed by an explicit intensity+foreground reset rather
 * than a bare `\x1b[0m`. A lone reset leaves the terminal's own dim/bold state
 * applied to whatever follows, which shows up as a statusline that changes shade
 * depending on what the line above it printed.
 */
const STABLE_PREFIX = `${CLEAR_INTENSITY}${CLEAR_FOREGROUND}`;
const STABLE_SUFFIX = `${RESET}${CLEAR_INTENSITY}${CLEAR_FOREGROUND}`;

function colorEnabled() {
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR) return true;
  return CONFIG.colors !== false;
}

function colorize(text, code) {
  if (!colorEnabled() || !code) return String(text);
  return `${STABLE_PREFIX}${code}${text}${STABLE_SUFFIX}`;
}

function codeFor(name) {
  if (!name || name === 'none' || name === 'default' || name === 'white') return '';
  return COLOR_CODES[name] || '';
}

/** Returns a (string) => string painter; identity when the name is unknown. */
function paint(name) {
  const code = codeFor(name);
  return code ? (s) => colorize(s, code) : (s) => String(s);
}

const green = (s) => colorize(s, COLOR_CODES.green);
const yellow = (s) => colorize(s, COLOR_CODES.yellow);
const red = (s) => colorize(s, COLOR_CODES.red);

function contextColorName(percent) {
  const { midAt, highAt, low, mid, high } = CONFIG.context;
  if (percent >= highAt) return high;
  if (percent >= midAt) return mid;
  return low;
}

/** `▰▰▰▱▱▱` — filled portion in the threshold color, remainder dim. */
function coloredBar(percent, width) {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;

  if (!colorEnabled()) return '▰'.repeat(filled) + '▱'.repeat(empty);

  const code = codeFor(contextColorName(percent)) || COLOR_CODES.green;
  return (
    `${STABLE_PREFIX}${code}${'▰'.repeat(filled)}` +
    `${STABLE_PREFIX}${DIM}${'▱'.repeat(empty)}${STABLE_SUFFIX}`
  );
}

// ============================================================================
// TERMINAL STRING WIDTH
// ============================================================================

const GRAPHEME_SEGMENTER =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** True when every code point is a C0 control or DEL — none of which occupy a column. */
function isControlOnly(cluster) {
  for (const ch of cluster) {
    const code = ch.codePointAt(0);
    if (code > 0x1f && code !== 0x7f) return false;
  }
  return true;
}

/**
 * Columns a string actually occupies: ANSI stripped, emoji and full-width CJK
 * counted as two, combining marks and zero-width joiners as none. `String.length`
 * would over-count every icon in CONFIG and wrap the line early.
 */
function visibleLength(str) {
  if (!str || typeof str !== 'string') return 0;
  const noAnsi = str.replace(/\x1b\[[0-9;]*m/g, '');
  const clusters = GRAPHEME_SEGMENTER
    ? Array.from(GRAPHEME_SEGMENTER.segment(noAnsi), (s) => s.segment)
    : Array.from(noAnsi);

  let len = 0;
  for (const cluster of clusters) {
    if (!cluster) continue;
    // Control characters and DEL occupy no columns.
    if (isControlOnly(cluster)) continue;
    if (/^\p{Mark}+$/u.test(cluster)) continue;

    const first = cluster.codePointAt(0);
    if (first === 0x200d || first === 0xfe0e || first === 0xfe0f) continue;

    if (/\p{Extended_Pictographic}/u.test(cluster)) {
      len += 2;
      continue;
    }

    if (
      first >= 0x1100 &&
      (first <= 0x115f ||
        first === 0x2329 ||
        first === 0x232a ||
        (first >= 0x2e80 && first <= 0xa4cf && first !== 0x303f) ||
        (first >= 0xac00 && first <= 0xd7a3) ||
        (first >= 0xf900 && first <= 0xfaff) ||
        (first >= 0xfe10 && first <= 0xfe19) ||
        (first >= 0xfe30 && first <= 0xfe6f) ||
        (first >= 0xff00 && first <= 0xff60) ||
        (first >= 0xffe0 && first <= 0xffe6) ||
        (first >= 0x1f200 && first <= 0x1f251) ||
        (first >= 0x20000 && first <= 0x3fffd))
    ) {
      len += 2;
      continue;
    }

    len += 1;
  }
  return len;
}

/** stdout is a pipe here, so stderr is what carries the real column count. */
function terminalWidth() {
  if (process.stderr.columns) return process.stderr.columns;
  const parsed = parseInt(env.COLUMNS || '', 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 120;
}

// ============================================================================
// GIT
// ============================================================================

const CACHE_MISS = Symbol('cache_miss');
const CACHE_SKIP = Symbol('cache_skip');

function isTimeout(error) {
  if (!error) return false;
  if (error.killed || error.signal === 'SIGTERM') return true;
  return /timed out|etimedout/i.test(String(error.message || ''));
}

/**
 * No `2>/dev/null` anywhere in here — this runs under cmd.exe as readily as under a
 * POSIX shell, and that redirect is a syntax error there. stderr is dropped via stdio.
 */
function execIn(cmd, cwd) {
  try {
    const output = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      cwd: cwd || undefined,
      timeout: CONFIG.git.timeoutMs,
    });
    return { output: output.trim(), timedOut: false };
  } catch (error) {
    return { output: '', timedOut: isTimeout(error) };
  }
}

function gitCachePath(cwd) {
  const hash = crypto.createHash('md5').update(cwd).digest('hex').slice(0, 8);
  return path.join(os.tmpdir(), `statusline-git-${hash}.json`);
}

/** No existsSync probe first — that is a TOCTOU race; just read and catch. */
function readGitCache(cachePath, { allowStale = false } = {}) {
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (allowStale || Date.now() - cache.timestamp < CONFIG.git.cacheTtlMs) {
      return cache.data; // may legitimately be null: "checked, not a repo"
    }
  } catch {
    // absent, corrupt or expired all mean the same thing
  }
  return CACHE_MISS;
}

/** Temp file + rename, so a concurrent render never reads a half-written cache. */
function writeGitCache(cachePath, data) {
  const tmp = `${cachePath}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ timestamp: Date.now(), data }));
    fs.renameSync(tmp, cachePath);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

function countLines(str) {
  if (!str) return 0;
  return str.split('\n').filter((l) => l.trim()).length;
}

function fetchGitInfo(cwd) {
  const repoCheck = execIn('git rev-parse --git-dir', cwd);
  if (repoCheck.timedOut) return CACHE_SKIP;
  if (!repoCheck.output) return null;

  const branchPrimary = execIn('git branch --show-current', cwd);
  const branchFallback = execIn('git rev-parse --short HEAD', cwd);
  const unstaged = execIn('git diff --name-only', cwd);
  const staged = execIn('git diff --cached --name-only', cwd);
  const aheadBehind = execIn('git rev-list --left-right --count @{u}...HEAD', cwd);

  if (
    branchPrimary.timedOut ||
    branchFallback.timedOut ||
    unstaged.timedOut ||
    staged.timedOut ||
    aheadBehind.timedOut
  ) {
    return CACHE_SKIP;
  }

  let ahead = 0;
  let behind = 0;
  if (aheadBehind.output) {
    const parts = aheadBehind.output.split(/\s+/);
    behind = parseInt(parts[0], 10) || 0;
    ahead = parseInt(parts[1], 10) || 0;
  }

  return {
    // Detached HEAD has no branch name, so fall back to the short sha.
    branch: branchPrimary.output || branchFallback.output,
    unstaged: countLines(unstaged.output),
    staged: countLines(staged.output),
    ahead,
    behind,
  };
}

function getGitInfo(cwd) {
  const cachePath = gitCachePath(cwd);

  const cached = readGitCache(cachePath);
  if (cached !== CACHE_MISS) return cached;

  const data = fetchGitInfo(cwd);
  if (data === CACHE_SKIP) {
    // A timeout must not be cached as "not a repo" — that would hide the branch for
    // a full TTL. Prefer the last known value even if stale.
    const stale = readGitCache(cachePath, { allowStale: true });
    return stale === CACHE_MISS ? null : stale;
  }

  // Cache the null too, so a non-repo directory stops spawning five git processes
  // on every keystroke. This project is not a repo yet, which is exactly that case.
  writeGitCache(cachePath, data);
  return data;
}

// ============================================================================
// SECTIONS
// ============================================================================

function renderModel(ctx) {
  return `${CONFIG.icons.model} ${paint(CONFIG.sectionColors.model)(ctx.modelName)}`;
}

function renderContext(ctx) {
  if (ctx.contextPercent <= 0) return '';
  const bar = coloredBar(ctx.contextPercent, CONFIG.context.barWidth);
  const pct = paint(contextColorName(ctx.contextPercent))(`${ctx.contextPercent}%`);
  return `${bar} ${pct}`;
}

function renderDirectory(ctx) {
  return `${CONFIG.icons.directory} ${paint(CONFIG.sectionColors.directory)(ctx.currentDir)}`;
}

/** `🌿 main (2, +1, 3↑)` — unstaged, staged, ahead, behind. */
function renderGit(ctx) {
  if (!ctx.gitBranch) return '';
  let part = `${CONFIG.icons.git} ${paint(CONFIG.sectionColors.git)(ctx.gitBranch)}`;

  const indicators = [];
  if (ctx.gitUnstaged > 0) indicators.push(`${ctx.gitUnstaged}`);
  if (ctx.gitStaged > 0) indicators.push(`+${ctx.gitStaged}`);
  if (ctx.gitAhead > 0) indicators.push(`${ctx.gitAhead}↑`);
  if (ctx.gitBehind > 0) indicators.push(`${ctx.gitBehind}↓`);
  if (indicators.length > 0) part += ` ${yellow(`(${indicators.join(', ')})`)}`;

  return part;
}

function renderCost(ctx) {
  if (!ctx.costText) return '';
  return `${CONFIG.icons.cost} ${paint(CONFIG.sectionColors.cost)(ctx.costText)}`;
}

function renderChanges(ctx) {
  if (ctx.linesAdded <= 0 && ctx.linesRemoved <= 0) return '';
  return `${CONFIG.icons.changes} ${green(`+${ctx.linesAdded}`)} ${red(`-${ctx.linesRemoved}`)}`;
}

const RENDERERS = {
  model: renderModel,
  context: renderContext,
  directory: renderDirectory,
  git: renderGit,
  cost: renderCost,
  changes: renderChanges,
};

function section(id, ctx) {
  if (!CONFIG.sections[id]) return '';
  const fn = RENDERERS[id];
  return (fn && fn(ctx)) || '';
}

// ============================================================================
// RENDER MODES
// ============================================================================

/**
 * Groups collapse onto one line when they fit, and peel off in priority order when
 * they do not: stats go first, then the session group, and only in the narrowest
 * terminal does each part get its own line.
 */
function sessionLines(ctx) {
  const threshold = Math.floor(terminalWidth() * CONFIG.responsiveBreakpoint);

  const dirPart = section('directory', ctx);
  const branchPart = section('git', ctx);
  const sessionPart = ['model', 'context'].map((id) => section(id, ctx)).filter(Boolean).join('  ');
  const statsPart = ['cost', 'changes'].map((id) => section(id, ctx)).filter(Boolean).join('  ');
  const locationPart = [dirPart, branchPart].filter(Boolean).join('  ');

  const statsLen = visibleLength(statsPart);
  const allOneLine = `${sessionPart}  ${locationPart}  ${statsPart}`;
  const sessionLocation = `${sessionPart}  ${locationPart}`;
  const sessionStats = `${sessionPart}  ${statsPart}`;

  const lines = [];
  if (visibleLength(allOneLine) <= threshold && statsLen > 0) {
    lines.push(allOneLine);
  } else if (visibleLength(sessionLocation) <= threshold) {
    lines.push(sessionLocation);
    if (statsLen > 0) lines.push(statsPart);
  } else if (visibleLength(locationPart) <= threshold) {
    lines.push(locationPart);
    if (statsLen > 0 && visibleLength(sessionStats) <= threshold) {
      lines.push(sessionStats);
    } else {
      lines.push(sessionPart);
      if (statsLen > 0) lines.push(statsPart);
    }
  } else {
    if (dirPart) lines.push(dirPart);
    if (branchPart) lines.push(branchPart);
    lines.push(sessionPart);
    if (statsLen > 0) lines.push(statsPart);
  }

  return lines.filter((l) => l.trim());
}

function renderFull(ctx) {
  for (const line of sessionLines(ctx)) console.log(line);
}

function renderCompact(ctx) {
  const first = ['model', 'context'].map((id) => section(id, ctx)).filter(Boolean).join('  ');
  const second = ['directory', 'git'].map((id) => section(id, ctx)).filter(Boolean).join('  ');
  if (first) console.log(first);
  if (second) console.log(second);
}

/** One line, and the bar becomes a battery glyph that reddens when context is tight. */
function renderMinimal(ctx) {
  const parts = [];
  if (CONFIG.sections.model) parts.push(renderModel(ctx));

  if (CONFIG.sections.context && ctx.contextPercent > 0) {
    const glyph = CONFIG.icons.battery;
    const icon = ctx.contextPercent > CONFIG.context.midAt ? red(glyph) : glyph;
    parts.push(`${icon} ${ctx.contextPercent}%`);
  }

  if (CONFIG.sections.git && ctx.gitBranch) parts.push(renderGit(ctx));
  if (CONFIG.sections.directory) parts.push(renderDirectory(ctx));

  console.log(parts.filter(Boolean).join('  '));
}

// ============================================================================
// MAIN
// ============================================================================

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => chunks.push(chunk));
    stdin.on('end', () => resolve(chunks.join('')));
    stdin.on('error', reject);
  });
}

function expandHome(filePath) {
  const home = os.homedir();
  return filePath.startsWith(home) ? filePath.replace(home, '~') : filePath;
}

async function main() {
  try {
    const input = await readStdin();
    if (!input.trim()) {
      console.error('No input provided');
      process.exit(1);
    }

    const data = JSON.parse(input);
    const cwd = data.workspace?.current_dir || data.cwd || process.cwd();

    const git = getGitInfo(cwd) || {};

    // Context: prefer the payload's own percentage; compute it only as a fallback.
    const usage = data.context_window?.current_usage || {};
    const contextSize = data.context_window?.context_window_size || 0;
    let contextPercent = 0;
    if (contextSize > 0) {
      const preCalc = data.context_window?.used_percentage;
      if (typeof preCalc === 'number' && preCalc >= 0) {
        contextPercent = Math.round(preCalc);
      } else if (contextSize > CONFIG.autocompactBuffer) {
        const total =
          (usage.input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0);
        contextPercent = Math.min(
          100,
          Math.round(((total + CONFIG.autocompactBuffer) / contextSize) * 100),
        );
      }
    }

    const costUSD = data.cost?.total_cost_usd;
    const ctx = {
      modelName: data.model?.display_name || 'Claude',
      currentDir: expandHome(cwd),
      gitBranch: git.branch || '',
      gitUnstaged: git.unstaged || 0,
      gitStaged: git.staged || 0,
      gitAhead: git.ahead || 0,
      gitBehind: git.behind || 0,
      contextPercent,
      costText:
        costUSD && /^\d+(\.\d+)?$/.test(String(costUSD))
          ? `$${parseFloat(costUSD).toFixed(4)}`
          : null,
      linesAdded: data.cost?.total_lines_added || 0,
      linesRemoved: data.cost?.total_lines_removed || 0,
    };

    switch (CONFIG.mode) {
      case 'none':
        console.log('');
        break;
      case 'minimal':
        renderMinimal(ctx);
        break;
      case 'compact':
        renderCompact(ctx);
        break;
      case 'full':
      default:
        renderFull(ctx);
        break;
    }
  } catch {
    // Never leave the statusline blank — a bare cwd beats an empty bar.
    console.log(`📁 ${process.cwd() || 'unknown'}`);
  }
}

main().catch(() => {
  console.log('📁 error');
  process.exit(1);
});
