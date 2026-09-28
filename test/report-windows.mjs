// Reports what window the shipped solver picks for the accounts measured live.
// Uses the harness so the numbers come from background.js itself.
import { solveWindowDays, monthsBetween } from './harness.mjs';

const TODAY = '2026-09-28';
const accounts = [
  ['liljayxxo', '2023-01-01', 72],
  ['cnn', '2007-02-01', 429200],
  ['elonmusk', '2009-06-01', 109100],
  ['natgeo', '2008-11-01', 73600],
  ['XboxSupport', '2009-07-01', 3000000]
];

console.log(`today = ${TODAY}\n`);
console.log('account       posts      months   window   P(hit)   vs old 7d');
console.log('-'.repeat(64));
for (const [user, join, posts] of accounts) {
  const months = monthsBetween(join, TODAY);
  const days = solveWindowDays(posts, join, TODAY);
  const lambda = posts / months;
  const p = 1 - Math.exp(-(lambda * days / 30));
  const pOld = 1 - Math.exp(-(lambda * 7 / 30));
  console.log(
    `${user.padEnd(12)} ${posts.toLocaleString().padStart(9)} ${String(months).padStart(8)}` +
    ` ${String(days).padStart(6)}d ${(p * 100).toFixed(1).padStart(7)}%   ${(pOld * 100).toFixed(1)}%`
  );
}

console.log('\ngrowth on repeated empty windows (doubling, capped at 90):');
let w = solveWindowDays(72, '2023-01-01', TODAY);
const steps = [w];
for (let i = 0; i < 3; i++) { w = Math.min(90, w * 2); steps.push(w); }
console.log('  ' + steps.join(' -> ') + ' days');
