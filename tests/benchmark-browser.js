(function () {
  if (!window.__binaryStore) throw new Error('Bot store is not ready');
  var store = window.__binaryStore;
  var originalDispatch = store.dispatch;
  var started = performance.now();
  var previous = store.getState().game;
  var stageStarted = started, emptyAt = null, levelReadyAt = null;
  var run = window.__farmBenchmark = {
    label: window.__farmBenchmarkLabel || 'baseline',
    url: location.href, userAgent: navigator.userAgent,
    started: new Date().toISOString(), done: false,
    targetStage: window.__farmBenchmarkTarget || 40,
    levels: [], actions: {}, gaps: [], transitions: [], errors: [],
    visibility: [], progressViolations: [], levelGaps: [], lastScore: previous.score,
    lastStage: previous.stage, lastCompleted: previous.problemsCompleted
  };
  function pauseBot() {
    var button = Array.from(document.querySelectorAll('button')).find(function (b) { return b.textContent === '⏸ Пауза'; });
    if (button) button.click();
  }
  store.dispatch = function (action) {
    var type = typeof action === 'function' ? 'thunk' : action.type;
    var before = store.getState().game;
    var t = performance.now();
    var result = originalDispatch(action);
    var elapsed = performance.now() - t;
    var item = run.actions[type] || (run.actions[type] = {count:0, ms:0, maxMs:0, stages:{}});
    item.count++; item.ms += elapsed; item.maxMs = Math.max(item.maxMs, elapsed);
    var stageItem = item.stages[before.stage] || (item.stages[before.stage] = {count:0,ms:0,maxMs:0});
    stageItem.count++; stageItem.ms += elapsed; stageItem.maxMs = Math.max(stageItem.maxMs,elapsed);
    var g = store.getState().game;
    if (type === 'CHANGE_PROBLEM_GUESS' && !before.isIntro) {
      var p = before.activeProblems.find(function (p) { return p.id === action.payload.id; });
      var correct = p && p.answer === action.payload.guess;
      if (!p) run.progressViolations.push({type:'stale-guess',stage:before.stage,id:action.payload.id});
      if (correct && (g.problemsCompleted !== before.problemsCompleted + 1 || g.score !== before.score + 100 + before.stage * 25)) {
        run.progressViolations.push({type:type,stage:before.stage,beforeScore:before.score,afterScore:g.score,beforeCompleted:before.problemsCompleted,afterCompleted:g.problemsCompleted});
      }
    }
    if (type === 'BOARD_CLEAR' && g.score !== before.score + 250) run.progressViolations.push({type:type,stage:g.stage});
    if (type === 'NEXT_STAGE' && !before.isIntro && before.problemsCompleted < 15 + before.stage * 5) run.progressViolations.push({type:'premature-stage',stage:before.stage});
    return result;
  };
  var unsubscribe = store.subscribe(function () {
    var g = store.getState().game, now = performance.now();
    if (g.stage !== previous.stage) {
      run.levels.push({stage:previous.stage,ms:now-stageStarted,completed:previous.problemsCompleted,score:previous.score,nextScore:g.score,problems:previous.activeProblems.length});
      run.transitions.push({stage:g.stage,atMs:now-started});
      if (levelReadyAt !== null) run.levelGaps.push({stage:previous.stage,ms:now-levelReadyAt});
      levelReadyAt = null;
      stageStarted = now;
      emptyAt = null;
      if (g.stage >= run.targetStage) {
        run.done = true; run.elapsedMs = now-started;
        pauseBot();
      }
    }
    if (!g.isIntro && g.stage >= 0 && g.problemsCompleted >= 15 + g.stage * 5 && levelReadyAt === null) levelReadyAt = now;
    if (previous.activeProblems.length && !g.activeProblems.length) emptyAt = {at:now,stage:g.stage,completed:g.problemsCompleted};
    if (!previous.activeProblems.length && g.activeProblems.length && emptyAt) {
      run.gaps.push({stage:emptyAt.stage,completed:emptyAt.completed,ms:now-emptyAt.at,sameStage:g.stage===emptyAt.stage});
      emptyAt = null;
    }
    if (g.stage === previous.stage && g.problemsCompleted < previous.problemsCompleted && !g.isIntro) run.progressViolations.push({type:'completed-decreased',stage:g.stage});
    run.lastScore=g.score; run.lastStage=g.stage; run.lastCompleted=g.problemsCompleted;
    previous=g;
  });
  var onError = function (e) { run.errors.push(String(e.message || e.reason || e)); };
  var onVisibility = function () { run.visibility.push({atMs:performance.now()-started,state:document.visibilityState}); };
  window.addEventListener('error',onError);
  window.addEventListener('unhandledrejection',onError);
  document.addEventListener('visibilitychange',onVisibility);
  run.cleanup = function () { unsubscribe(); store.dispatch=originalDispatch; window.removeEventListener('error',onError); window.removeEventListener('unhandledrejection',onError); document.removeEventListener('visibilitychange',onVisibility); };
  var button = Array.from(document.querySelectorAll('button')).find(function (b) { return b.textContent === '▶ Бот'; });
  if (!button) throw new Error('Bot start button missing');
  button.click();
})();
