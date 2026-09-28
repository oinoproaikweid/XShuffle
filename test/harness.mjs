/**
 * Shared test helpers.
 *
 * The adaptive-window maths and the post-count parser live inside the
 * extension's IIFEs, where they cannot be imported directly. Rather than
 * re-declare them here - which would let the tests pass against logic the
 * extension no longer ships - these helpers lift the real function bodies
 * straight out of the source files and evaluate them.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let pass = 0;
const failures = [];

/** Register a test. The body throws on failure. */
export function run(name, body) {
  try {
    body();
    pass++;
    console.log(`  \x1b[32mok\x1b[0m   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
    console.log(`         ${error.message.split('\n').join('\n         ')}`);
  }
}

export function summary(label) {
  console.log(`\n${label}: ${pass} passed, ${failures.length} failed`);
  return failures.length === 0;
}

/**
 * Extract a top-level function declaration by name from a source file.
 * Handles the nested functions inside the extension's IIFE, which is why it
 * scans for the declaration rather than assuming a column-0 position.
 */
function extractFunction(source, name) {
  const pattern = new RegExp(`function\\s+${name}\\s*\\(`);
  const match = pattern.exec(source);
  if (!match) throw new Error(`could not find function ${name} in source`);
  const start = match.index;

  // Phase 1: consume the parameter list. Arrow functions and default values
  // inside params are not present in this codebase, so tracking parens alone
  // is enough to find the body.
  let i = source.indexOf('(', start);
  let paren = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(') paren++;
    else if (ch === ')') {
      paren--;
      if (paren === 0) { i++; break; }
    }
  }

  // Phase 2: brace-match the body.
  let depth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

const backgroundSrc = readFileSync(join(root, 'background.js'), 'utf8');
const contentSrc = readFileSync(join(root, 'content.js'), 'utf8');

/**
 * Evaluate the window solver from the real background.js, together with the
 * constants it closes over, so the clamps under test are the shipped ones.
 *
 * new Function() is safe here: the interpolated string is source read from this
 * repository's own extension files, never user input or network data. This is
 * a test-only shim to reach functions that live inside the extension's IIFE.
 */
function buildWindowSolver() {
  const constSource = ['MIN_WINDOW_DAYS', 'MAX_WINDOW_DAYS', 'TARGET_HIT']
    .map(name => {
      const match = new RegExp(`const\\s+${name}\\s*=\\s*([^;]+);`).exec(backgroundSrc);
      if (!match) throw new Error(`missing constant ${name}`);
      return match[0];
    })
    .join('\n');
  const source = [
    constSource,
    extractFunction(backgroundSrc, 'monthsBetween'),
    extractFunction(backgroundSrc, 'solveWindowDays')
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${source}\nreturn { solveWindowDays, monthsBetween };`)();
}

function buildPostCountParser() {
  const source = extractFunction(contentSrc, 'parsePostCount');
  // eslint-disable-next-line no-new-func
  return new Function(`${source}\nreturn parsePostCount;`)();
}

const { solveWindowDays, monthsBetween } = buildWindowSolver();
const parsePostCount = buildPostCountParser();

export { solveWindowDays, monthsBetween, parsePostCount, extractFunction, backgroundSrc, contentSrc };

export function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}
