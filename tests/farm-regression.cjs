// Проверки отмены партий, сохранения активных строк и устаревших решений.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../Binary_Game_Bot.user.js'), 'utf8');
const scheduler = source.slice(source.indexOf('  var FARM_DELAY'), source.indexOf('  var HINT_OPACITY'));
function schedulerFixture(channel = true) {
  const tasks = [], events = [];
  const state = {game: {stage: 4, activeProblems: [], problemsCompleted: 0}, time: {isPaused: false}};
  const context = {Date, running: true, store: {getState: () => state},
    document: {querySelector: () => null}, linesRequired: () => 35,
    logFarm: () => {}, beginStage: () => events.push('batch'), scheduleFarmTick: () => events.push('tick'),
    setTimeout: fn => { tasks.push(fn); return tasks.length; }, clearTimeout: () => {}};
  if (channel) context.MessageChannel = function () {
    this.port1 = {onmessage: null};
    this.port2 = {postMessage: data => tasks.push(() => this.port1.onmessage({data}))};
  };
  vm.createContext(context); vm.runInContext(scheduler, context);
  return {context, state, events, tasks, run: code => vm.runInContext(code, context), flush: () => {while (tasks.length) tasks.shift()();}};
}
for (const channel of [true, false]) {
  let f = schedulerFixture(channel);
  f.run('scheduleFastBatch(4);scheduleFastBatch(4)');
  assert.equal(f.tasks.length, 1); f.flush(); assert.deepEqual(f.events, ['batch', 'tick']);
  f = schedulerFixture(channel);
  f.run('scheduleFastBatch(4);cancelFastBatch();scheduleFastBatch(4)');
  f.flush(); assert.deepEqual(f.events, ['batch', 'tick']);
  for (const stop of [f => {f.context.running = false;}, f => {f.state.time.isPaused = true;},
    f => {f.state.game.stage++;}, f => {f.state.game.activeProblems.push({id: 1});},
    f => {f.state.game.problemsCompleted = 35;}, f => {f.state.game.isGameOver = true;}]) {
    f = schedulerFixture(channel); f.run('scheduleFastBatch(4)'); stop(f); f.flush();
    assert.deepEqual(f.events, []);
  }
}
// Очистка React не должна удалять активные элементы или менять Redux.
const cleanup = source.slice(source.indexOf('  function clearExitedProblems()'), source.indexOf('  var running = false;'));
const active = {props: {in: true}}, exiting = {props: {in: false}}, unknown = {props: {}};
let children = {active, exiting, unknown};
const context = {running: true, problemGroup: {setState: fn => {
  const result = fn({children}); if (result) children = result.children;
}}, renderCleanup: {batches: 0, removed: 0, maxRetained: 0}};
vm.createContext(context); vm.runInContext(cleanup, context);
vm.runInContext('clearExitedProblems()', context);
assert.deepEqual(Object.keys(children), ['active', 'unknown']); assert.equal(children.active, active);
assert.equal(context.renderCleanup.removed, 1);
vm.runInContext('clearExitedProblems()', context); assert.equal(context.renderCleanup.removed, 1);
// Устаревшая копия строки должна выйти до dispatch и начисления бонуса.
const solve = source.slice(source.indexOf('  function solve(problem)'), source.indexOf('  /* ---------- 4б.'));
let dispatches = 0;
const staleContext = {store: {getState: () => ({game: {activeProblems: []}})},
  measuredDispatch: () => dispatches++, performance};
vm.createContext(staleContext); vm.runInContext(solve, staleContext);
vm.runInContext('solve({id: 99, answer: 42})', staleContext); assert.equal(dispatches, 0);
staleContext.store.getState = () => ({game: {activeProblems: [{id: 99, answer: 42, currentGuess: 42}]}});
vm.runInContext('solve({id: 99, answer: 42})', staleContext); assert.equal(dispatches, 0);
const modalCode = source.slice(source.indexOf('  var lastClick = {}'), source.indexOf('  /* ---------- 6.'));
let stage = 1, clicks = 0;
const button = {textContent: 'Next Level', closest: () => ({className: 'window modal'}), click: () => clicks++};
const modalContext = {Date: {now: () => 1000}, store: {getState: () => ({game: {stage}})},
  document: {querySelector: () => ({querySelectorAll: () => [button]})}};
vm.createContext(modalContext); vm.runInContext(modalCode, modalContext);
assert.equal(vm.runInContext('clickModalButton("Next Level")', modalContext), true);
assert.equal(vm.runInContext('clickModalButton("Next Level")', modalContext), false);
stage++;
assert.equal(vm.runInContext('clickModalButton("Next Level")', modalContext), true);
assert.equal(clicks, 2);
console.log('PASS: batch cancellation/channel fallback, active React rows, stale solve guard, stage-aware modal cooldown');
