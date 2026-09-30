const fs = require('node:fs');
const assert = require('node:assert/strict');
const files = process.argv.slice(2);
if (!files.length) throw new Error('Usage: node tests/verify-benchmark.cjs <candidate.json> ...');
for (const file of files) {
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(run.done, true, 'Run must finish naturally');
  assert.deepEqual(run.errors, []); assert.deepEqual(run.progressViolations, []);
  const levels = run.levels.filter(l => l.stage >= 0);
  assert.equal(levels.length, run.targetStage);
  let score = 0;
  for (let stage = 0; stage < run.targetStage; stage++) {
    const level = levels[stage], required = 15 + stage * 5;
    assert.equal(level.stage, stage); assert.equal(level.completed, required);
    // Три строки в партии. Частично очищенная доска при переходе не даёт +250.
    score += required * (100 + stage * 25) + Math.floor(required / 3) * 250;
    assert.equal(level.score, score, `Score mismatch at UI level ${stage + 1}`);
    assert.equal(level.nextScore, score); assert.equal(level.problems, 0);
  }
  assert.equal(run.lastScore, score);
  const late = levels.filter(l => l.stage >= 24 && l.stage <= 34);
  const mean = list => list.reduce((a,b) => a+b,0)/list.length;
  console.log(JSON.stringify({file, elapsedMs:run.elapsedMs, score,
    meanLevels25to35Ms:mean(late.map(l=>l.ms)),
    meanLateBatchGapMs:mean(run.gaps.filter(g=>g.stage>=24&&g.stage<=34&&g.sameStage).map(g=>g.ms)),
    meanLateLevelGapMs:mean((run.levelGaps||[]).filter(g=>g.stage>=24&&g.stage<=34).map(g=>g.ms))}));
}
