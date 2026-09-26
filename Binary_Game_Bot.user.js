// ==UserScript==
// @name         Binary Game Bot
// @namespace    https://netacad.sadlab.su/
// @version      3.13
// @description  Автоматически проходит Cisco Binary Game
// @match        https://netacad.sadlab.su/games/binary/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/BLXCKBXXST/binary-game-bot/main/Binary_Game_Bot.user.js
// @downloadURL  https://raw.githubusercontent.com/BLXCKBXXST/binary-game-bot/main/Binary_Game_Bot.user.js
// ==/UserScript==

(function () {
  /* ================= НАСТРОЙКИ ================= */
  var FARM_DELAY = Math.max(5, Math.min(1000, Number(localStorage.getItem('blxckFarmDelay')) || 25));
  var HINT_OPACITY = Math.max(0, Math.min(100, Number(localStorage.getItem('blxckHintOpacity') ?? 45)));
  /* default */ // /* Прозрачность подсказки 💡 в процентах: 0 — невидимая, 100 — яркая */
  /* ============================================= */

  if (window.__binaryBot) { return; }
  window.__binaryBot = true;

  /* ---------- 1. Находим Redux store игры через React fiber ---------- */
  function findStore() {
    var rootEl = document.getElementById('reactRoot');
    if (!rootEl) return null;
    var start = null;
    var keys = Object.keys(rootEl);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (k === '_reactRootContainer') { start = rootEl[k]._internalRoot.current; break; }
      if (k.indexOf('__reactContainer') === 0) { var v = rootEl[k]; start = v.current ? v.current : v; break; }
      if (k.indexOf('__reactInternalInstance') === 0) { start = rootEl[k]; break; }
    }
    if (!start) return null;
    while (start.return) start = start.return;
    var stack = [start];
    while (stack.length) {
      var f = stack.pop();
      if (!f) continue;
      if (f.memoizedProps && f.memoizedProps.store &&
          typeof f.memoizedProps.store.getState === 'function') return f.memoizedProps.store;
      if (f.stateNode && f.stateNode.store &&
          typeof f.stateNode.store.getState === 'function') return f.stateNode.store;
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
    return null;
  }

  var store = null;
  var running = false;
  var timer = null, farmWorker = null, unsubscribeFarm = null, modalObserver = null;
  var tickQueued = false, tickBusy = false, lastFarmSignature = '', lastFarmError = 0;
  var lastModalAttempt = 0, farmTicks = 0, farmStageStart = 0;
  var farmStats = { started: 0, stage: null, stageTime: 0, levels: 0, solved: 0, lastSolved: 0, lastTick: 0, longestGap: 0, waitingSince: 0, waitingMs: 0, lastStats: 0 };
  var statsEl = null;
  var diagnostic = { started: 0, events: [], lastSample: 0, lastStage: null, lastProblems: null, lastPending: null, lastModal: null, lastVisibility: null, lastGapReport: 0, lastError: '' };
  function logFarm(type, data) {
    if (!diagnostic.started) diagnostic.started = Date.now();
    diagnostic.events.push(Object.assign({ t: Date.now() - diagnostic.started, type: type }, data || {}));
    if (diagnostic.events.length > 12000) diagnostic.events.splice(0, diagnostic.events.length - 12000);
  }
  function farmSnapshot(reason) {
    if (!store) return;
    var st = store.getState(), g = st.game, time = st.time || {};
    var pending = time.pendingActions || {};
    var modal = !!document.querySelector('.modal-container.displayed');
    var now = Date.now();
    var row = { stage: g.stage, score: g.score, completed: g.problemsCompleted,
      required: linesRequired(g.stage), problems: g.activeProblems.length,
      unsolved: g.activeProblems.filter(function (p) { return p.currentGuess !== p.answer; }).length,
      pending: Object.keys(pending), paused: !!time.isPaused,
      modal: modal, visible: document.visibilityState, running: running,
      solved: farmStats.solved, ticks: farmTicks, delay: FARM_DELAY };
    if (reason || now - diagnostic.lastSample >= 5000 || row.stage !== diagnostic.lastStage ||
        row.problems !== diagnostic.lastProblems || row.modal !== diagnostic.lastModal ||
        row.visible !== diagnostic.lastVisibility) {
      if (reason || row.stage !== diagnostic.lastStage || now - diagnostic.lastSample >= 5000 ||
          row.modal !== diagnostic.lastModal || row.visible !== diagnostic.lastVisibility) {
        logFarm(reason || 'sample', row);
        diagnostic.lastSample = now;
      }
      diagnostic.lastStage = row.stage;
      diagnostic.lastProblems = row.problems;
      diagnostic.lastModal = row.modal;
      diagnostic.lastVisibility = row.visible;
    }
  }
  function exportFarmLog() {
    farmSnapshot('export');
    var payload = { format: 'binary-game-bot-diagnostic', version: '3.13',
      exported: new Date().toISOString(), pageVisibility: document.visibilityState,
      stats: farmStats, events: diagnostic.events };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'binary-farm-log-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }
  window.__binaryBotExportLog = exportFarmLog;
  var panel = null, dot = null, status = null, toggleBtn = null, goalBtn = null;
  var hintOn = false, hintEl = null;
  var goalScore = 0;
  var goalDone = false;
  var rateStamp = null;

  var MAX_PROBLEMS = 7;
  function linesRequired(stage) { return stage < 0 ? 0 : 15 + stage * 5; }

  /* ---------- 2. Точная реплика таймерной очереди игры ---------- */
  function queue(action) {
    // Не плодим одинаковые игровые таймеры после восстановления вкладки.
    if (store.getState().time.pendingActions[action.id]) {
      store.dispatch({ type: 'CLEAR_PENDING_ACTION', payload: action.id });
    }
    if (action.id === 'add-problem') logFarm('queue', { id: action.id, delay: action.delay, repeat: !!action.repeat });
    store.dispatch({ type: 'QUEUE_ACTION', payload: action });
    setTimeout(function () { tryExecute(action.id); scheduleFarmTick(); }, action.delay);
  }
  function tryExecute(actionID) {
    store.dispatch({ type: 'UPDATE_TIME' });
    var st = store.getState();
    if (actionID in st.time.pendingActions) {
      var a = st.time.pendingActions[actionID];
      if (!st.time.isPaused && st.time.now >= a.scheduledTime) {
        store.dispatch({ type: 'CLEAR_PENDING_ACTION', payload: actionID });
        if (a.repeat) {
          var na = Object.assign({}, a);
          delete na.scheduledTime;
          queue(na);
        }
        if (actionID === 'add-problem') logFarm('queue-execute', { id: actionID, lateMs: Math.round(st.time.now - a.scheduledTime) });
        store.dispatch(a.action);
      }
    }
  }

  /* ---------- 3. Реплики игровых thunk'ов ---------- */
  function addProblemThunk() {
    return function (dispatch, getState) {
      dispatch({ type: 'ADD_PROBLEM' });
      var g = getState().game;
      if (g.isGameOver) {
        dispatch({ type: 'CLEAR_PENDING_ACTION', payload: 'add-problem' });
        dispatch({ type: 'CLEAR_PENDING_ACTION', payload: 'warning-sound' });
      }
    };
  }
  function beginStage() {
    var g = store.getState().game;
    logFarm('begin-stage', { stage: g.stage, completed: g.problemsCompleted });
    if (g.isIntro) { goToIntroStage('binary'); return; }
    var secs = Math.max((6.2 - g.stage * 0.8) * 2, 6);
    store.dispatch(addProblemThunk());
    store.dispatch(addProblemThunk());
    store.dispatch(addProblemThunk());
    queue({ id: 'add-problem', repeat: true, action: addProblemThunk(), delay: secs * 1000 });
  }
  function goToIntroStage(stage) {
    store.dispatch({ type: 'GO_TO_INTRO_STAGE', payload: stage });
    if (stage === 'binary') {
      store.dispatch({ type: 'ADD_CUSTOM_PROBLEM', payload: { answer: 2, currentGuess: 4, isDecimal: false } });
      store.dispatch({ type: 'ADD_CUSTOM_PROBLEM', payload: { answer: 5, currentGuess: 1, isDecimal: false } });
    } else {
      store.dispatch({ type: 'ADD_CUSTOM_PROBLEM', payload: { answer: 16, currentGuess: -1, isDecimal: true } });
      store.dispatch({ type: 'ADD_CUSTOM_PROBLEM', payload: { answer: 3, currentGuess: -1, isDecimal: true } });
    }
  }
  function resetBoard() {
    store.dispatch({ type: 'CLEAR_PENDING_ACTION', payload: 'add-problem' });
    store.dispatch({ type: 'CLEAR_PENDING_ACTION', payload: 'warning-sound' });
    store.dispatch({ type: 'RESET_BOARD' });
  }

  /* ---------- 4. Решение задачи = реплика changeProblemGuess ---------- */
  function solve(problem) {
    store.dispatch({ type: 'CHANGE_PROBLEM_GUESS', payload: { id: problem.id, guess: problem.answer } });
    var g = store.getState().game;
    if (g.activeProblems.length < MAX_PROBLEMS) {
      store.dispatch({ type: 'CLEAR_PENDING_ACTION', payload: 'warning-sound' });
    }
    if (g.activeProblems.length === 0) {
      if (g.isIntro) {
        if (g.introStage === 'binary') goToIntroStage('decimal');
        else if (g.introStage === 'decimal') {
          store.dispatch({ type: 'COMPLETE_INTRO' });
          beginStage();
        }
      } else {
        store.dispatch({ type: 'BOARD_CLEAR' });
        store.dispatch({ type: 'SHOW_TOAST', payload: 'Board Clear!' });
        queue({ id: 'toast-disappear', action: { type: 'HIDE_TOAST' }, delay: 2000 });
        if (g.problemsCompleted < linesRequired(g.stage)) {
          queue({ id: 'add-problem', action: function () { beginStage(); }, delay: FARM_DELAY });
        }
      }
    }
    g = store.getState().game;
    if (g.problemsCompleted >= linesRequired(g.stage)) resetBoard();
    farmStats.solved++;
    farmStats.lastSolved = Date.now();
  }

  /* ---------- 4б. Подсказка: ответ для самой нижней строки ---------- */
  function updateHint() {
    try {
      var g = store.getState().game;
      if (!g.activeProblems.length) { hintEl.textContent = ''; return; }
      var p = null;
      var els = document.querySelectorAll('.problem');
      if (els.length === g.activeProblems.length && els.length > 0) {
        var maxTop = -Infinity, idx = 0;
        for (var i = 0; i < els.length; i++) {
          var t = els[i].getBoundingClientRect().top;
          if (t > maxTop) { maxTop = t; idx = i; }
        }
        p = g.activeProblems[idx];
      } else {
        p = g.activeProblems[0];
      }
      if (!p) { hintEl.textContent = ''; return; }
      hintEl.textContent = p.isDecimal
        ? String(p.answer)
        : ('00000000' + p.answer.toString(2)).slice(-8);
    } catch (e) {}
  }

  /* ---------- 4в. Стоп-цель: останавливаемся на ближайшем счёте НЕ ВЫШЕ цели ---------- */
  /* 0 = решать, 1 = пропустить ПОСЛЕДНЮЮ строку (её решение даст ещё +250
     за чистое поле и перескочит цель — ждём подкрепления), 2 = стоп */
  function goalCheckSolve() {
    var g = store.getState().game;
    if (!goalScore || g.isGameOver || g.isIntro) return 0;
    if (g.score >= goalScore) return 2;
    var isLast = g.activeProblems.length <= 1;
    var next = g.score + 100 + g.stage * 25 + (isLast ? 250 : 0);
    if (next > goalScore) return isLast ? 1 : 2;
    return 0;
  }

  /* ---------- 4г. Детонатор: взрыв самой нижней строки ---------- */
  var detOn = false, detEl = null, detPlunger = null, detBusy = false;
  function boom(r) {
    var b = document.createElement('div');
    b.textContent = '💥';
    b.className = 'blxck-boom';
    b.style.left = (r.left + r.width / 2 - 32) + 'px';
    b.style.top = (r.top + r.height / 2 - 32) + 'px';
    document.body.appendChild(b);
    setTimeout(function () { b.remove(); }, 650);
  }
  function detonate() {
    if (detBusy || !store) return;
    detBusy = true;
    detPlunger.style.transform = 'translateY(23px)';
    setTimeout(function () { detPlunger.style.transform = 'translateY(0)'; detBusy = false; }, 320);
    setTimeout(function () {
      try {
        var g = store.getState().game;
        if (!g.activeProblems.length) return;
        if (goalScore && goalCheckSolve() !== 0) {
          /* Цель почти достигнута — взрыв перескочит её, отказ */
          detEl.style.animation = 'blxckNo 0.3s';
          setTimeout(function () { detEl.style.animation = ''; }, 350);
          return;
        }
        var p = g.activeProblems[0];
        var el = null;
        var els = document.querySelectorAll('.problem');
        if (els.length === g.activeProblems.length && els.length) {
          var maxTop = -Infinity;
          for (var i = 0; i < els.length; i++) {
            var t = els[i].getBoundingClientRect().top;
            if (t > maxTop) { maxTop = t; el = els[i]; p = g.activeProblems[i]; }
          }
        }
        if (p.currentGuess === p.answer) return;
        if (el) boom(el.getBoundingClientRect());
        var rr = document.getElementById('reactRoot');
        if (rr) {
          rr.style.animation = 'blxckShake 0.35s';
          setTimeout(function () { rr.style.animation = ''; }, 400);
        }
        solve(p);
      } catch (e) { console.log('detonate error', e); }
    }, 210);
  }

  /* ---------- 4д. Баклажан: мемное забивание нижней строки ---------- */
  var eggOn = false, eggEl = null, eggBusy = false;
  function smash() {
    if (eggBusy || !store) return;
    var g = store.getState().game;
    if (!g.activeProblems.length) return;
    if (goalScore && goalCheckSolve() !== 0) {
      eggEl.style.animation = 'blxckNo 0.3s';
      setTimeout(function () { eggEl.style.animation = ''; }, 350);
      return;
    }
    /* нижняя строка = самая старая = первая в state;
       элемент ищем по DOM отдельно, чтобы 💢 появлялся всегда */
    var p = g.activeProblems[0];
    var el = null;
    var els = document.querySelectorAll('.problem');
    var maxTop = -Infinity, maxIdx = -1;
    for (var i = 0; i < els.length; i++) {
      var t = els[i].getBoundingClientRect().top;
      if (t > maxTop) { maxTop = t; el = els[i]; maxIdx = i; }
    }
    if (els.length === g.activeProblems.length && maxIdx >= 0) p = g.activeProblems[maxIdx];
    if (p.currentGuess === p.answer) {
      for (var j = 0; j < g.activeProblems.length; j++) {
        if (g.activeProblems[j].currentGuess !== g.activeProblems[j].answer) { p = g.activeProblems[j]; break; }
      }
      if (p.currentGuess === p.answer) return;
    }
    eggBusy = true;

    /* Удар: баклажан летит к нижнему ряду и в полёте делает ровный кувырок
       на 360° (по часовой), удар приходится точно на завершение оборота */
    var r0 = eggEl.getBoundingClientRect();
    var dx = 0, dy = 0;
    if (el) {
      var rt = el.getBoundingClientRect();
      dx = (rt.left + rt.width * 0.85) - (r0.left + r0.width / 2);
      dy = (rt.top + rt.height / 2) - (r0.top + r0.height / 2);
      /* не вылетаем за границы экрана (с учётом роста и кувырка) */
      var vw = window.innerWidth, vh = window.innerHeight;
      var endX = r0.left + r0.width / 2 + dx;
      var endY = r0.top + r0.height / 2 + dy;
      if (endX < 145) dx += (145 - endX);
      if (endX > vw - 145) dx -= (endX - (vw - 145));
      if (endY < 145) dy += (145 - endY);
      if (endY > vh - 145) dy -= (endY - (vh - 145));
    }
    eggEl.animate([
      { transform: 'translate(0px,0px) scale(1) rotate(0deg)' },
      { transform: 'translate(' + (dx * 0.22) + 'px,' + (dy * 0.22 - 20) + 'px) scale(1.3) rotate(115deg)', offset: 0.2 },
      { transform: 'translate(' + (dx * 0.7) + 'px,' + (dy * 0.7) + 'px) scale(1.7) rotate(300deg)', offset: 0.45 },
      { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(1.85) rotate(360deg)', offset: 0.57 },
      { transform: 'translate(' + dx + 'px,' + (dy + 6) + 'px) scale(2.0,1.35) rotate(360deg)', offset: 0.63 },
      { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(1.8) rotate(360deg)', offset: 0.7 },
      { transform: 'translate(0px,0px) scale(1) rotate(360deg)' }
    ], { duration: 750, easing: 'ease-in-out' });

    setTimeout(function () {
      try {
        if (el) {
          el.animate(
            [{ transform: 'scaleY(1)', opacity: '1' },
             { transform: 'scaleY(0.08) scaleX(1.3)', opacity: '1', offset: 0.4 },
             { transform: 'scaleY(0.05) scaleX(1.5) translateY(-40px)', opacity: '0' }],
            { duration: 320, easing: 'ease-in', fill: 'forwards' }
          );
          var b = document.createElement('div');
          b.textContent = '💢';
          b.className = 'blxck-boom';
          var r = el.getBoundingClientRect();
          b.style.left = (r.left + r.width / 2 - 32) + 'px';
          b.style.top = (r.top + r.height / 2 - 32) + 'px';
          document.body.appendChild(b);
          setTimeout(function () { b.remove(); }, 650);
        }
        setTimeout(function () { solve(p); eggBusy = false; }, 150);
      } catch (e) { console.log('smash error', e); eggBusy = false; }
    }, 430);
  }


  /* ---------- 4е. Flappy СибГУТИ: полноэкранный режим вместо Binary.
       Сверху остаётся полоса SCORE/LEVEL/LINES LEFT — выглядит как HUD Flappy.
       Каждая пролетённая труба = один решённый ряд в Binary (фиксированная порция
       очков в пределах уровня + стандартный бонус +250 за чистую доску).
       Физика на дельта-тайминге — плавно на любом мониторе ---------- */
  var flappyOn = false, flWin = null, flCanvas = null, flCtx = null, flappyBtn = null;
  var flBird = null, flState = null, flRAF = 0, flKeyH = null, flResizeH = null;
  var flEarned = 0;
  var FL_GAP = 175, FL_PIPE_W = 64, FL_SPEED = 1.6, FL_GRAV = 0.22, FL_FLAP = -5.0, FL_SPAWN_MS = 2100;

  /* Труба пролетела → решаем один ряд в Binary (с уважением к стоп-цели) */
  function flappyPipePoint() {
    if (!store) return 0;
    try {
      var g = store.getState().game;
      if (g.isGameOver) return 0;
      if (!g.activeProblems.length) { clickModalButton('Next Level'); return 0; }
      if (goalScore) {
        var gc = goalCheckSolve();
        if (gc !== 0) { if (gc === 2) goalDone = true; return 0; }
      }
      var before = g.score;
      for (var i = 0; i < g.activeProblems.length; i++) {
        if (g.activeProblems[i].currentGuess !== g.activeProblems[i].answer) {
          solve(g.activeProblems[i]);
          var gained = store.getState().game.score - before;
          flEarned += gained;
          return gained;
        }
      }
    } catch (e) {}
    return 0;
  }

  /* Низ зелёной полосы со счётом — от неё начинается наше полотно */
  function flScoreBarBottom() {
    var el = document.querySelector('.gameStats');
    if (el) {
      var r0 = el.getBoundingClientRect();
      if (r0.height > 0) return r0.bottom;
    }
    var els = document.querySelectorAll('div');
    var best = null, bestArea = Infinity;
    for (var i = 0; i < els.length; i++) {
      var t = els[i].textContent;
      if (t && /score/i.test(t) && /level/i.test(t) && /lines/i.test(t)) {
        var r = els[i].getBoundingClientRect();
        var area = r.width * r.height;
        if (area > 0 && area < bestArea) { bestArea = area; best = r; }
      }
    }
    return best ? best.bottom : 0;
  }

  function flappyReset(mode) {
    flState = {
      mode: mode || 'ready', y: 200, vy: 0, rot: 0,
      pipes: [], score: 0, frame: 0, deadAt: 0, t: 0,
      spawnMs: 0, last: 0, floaters: [], stars: null, flash: 0
    };
  }

  function flappyFlap() {
    if (!flState) return;
    if (flState.mode === 'ready') { flState.mode = 'play'; flState.vy = FL_FLAP; }
    else if (flState.mode === 'play') { flState.vy = FL_FLAP; flState.flash = 1; }
    else if (Date.now() - flState.deadAt > 500) { flappyReset('ready'); }
  }

  function flappyResize() {
    if (!flWin || !flCanvas) return;
    // На ПК сохраняем компактное игровое поле по центру, на телефоне — всю ширину.
    var w = Math.min(window.innerWidth, 560);
    var h = window.innerHeight;
    if (flCanvas.width !== w || flCanvas.height !== h) {
      flCanvas.width = w;
      flCanvas.height = h;
      if (flState) flState.stars = null;
    }
    if (flState && flState.mode === 'ready') flState.y = h * 0.42;
  }

  function flappyStep(dt, dtms) {
    var s = flState;
    if (!s || !flCanvas) return;
    var W = flCanvas.width, H = flCanvas.height;
    var i, p;
    var bx = Math.max(W * 0.18, 90);
    s.t += dtms;
    for (i = s.floaters.length - 1; i >= 0; i--) {
      s.floaters[i].t += dtms;
      if (s.floaters[i].t > 900) s.floaters.splice(i, 1);
    }
    if (s.flash > 0) s.flash = Math.max(0, s.flash - dtms / 180);
    if (s.mode === 'ready') {
      s.y = H * 0.42 + Math.sin(s.t / 300) * 8;
      s.rot = Math.sin(s.t / 450) * 0.08;
      return;
    }
    if (s.mode !== 'play') return;
    s.frame += dt;
    s.vy += FL_GRAV * dt;
    s.y += s.vy * dt;
    var targetRot = Math.max(-0.42, Math.min(1.05, s.vy * 0.105));
    s.rot += (targetRot - s.rot) * Math.min(1, 0.2 * dt);
    s.spawnMs += dtms;
    if (s.spawnMs >= FL_SPAWN_MS) {
      s.spawnMs = 0;
      var top = 70 + Math.random() * Math.max(H - FL_GAP - 190, 60);
      s.pipes.push({ x: W + 10, top: top, passed: false });
    }
    for (i = 0; i < s.pipes.length; i++) {
      p = s.pipes[i];
      p.x -= FL_SPEED * dt;
      if (!p.passed && p.x + FL_PIPE_W < bx - 13) {
        p.passed = true;
        s.score++;
        var gained = flappyPipePoint();
        if (gained > 0) s.floaters.push({ x: bx + 30, y: s.y - 24, text: '+' + gained, t: 0 });
      }
    }
    if (s.pipes.length && s.pipes[0].x < -FL_PIPE_W - 20) s.pipes.shift();
    if (s.y < 14 || s.y > H - 36) { s.mode = 'dead'; s.deadAt = Date.now(); return; }
    for (i = 0; i < s.pipes.length; i++) {
      p = s.pipes[i];
      if (bx + 11 > p.x && bx - 11 < p.x + FL_PIPE_W) {
        if (s.y - 11 < p.top || s.y + 11 > p.top + FL_GAP) {
          s.mode = 'dead';
          s.deadAt = Date.now();
          return;
        }
      }
    }
  }

  function flRoundRect(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function flappyDraw() {
    var c = flCtx, s = flState;
    if (!c || !s || !flCanvas) return;
    var W = flCanvas.width, H = flCanvas.height;
    var i, p;
    /* небо с градиентом */
    var grd = c.createLinearGradient(0, 0, 0, H);
    grd.addColorStop(0, '#0a1a30');
    grd.addColorStop(0.55, '#123a5e');
    grd.addColorStop(1, '#1c5e8a');
    c.fillStyle = grd;
    c.fillRect(0, 0, W, H);
    /* звёзды с мерцанием */
    if (!s.stars) {
      s.stars = [];
      for (i = 0; i < 60; i++) {
        s.stars.push({ x: Math.random() * W, y: Math.random() * H * 0.75, r: 0.6 + Math.random() * 1.4, ph: Math.random() * 6.28 });
      }
    }
    for (i = 0; i < s.stars.length; i++) {
      var st = s.stars[i];
      c.globalAlpha = 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(s.t / 700 + st.ph));
      c.fillStyle = '#cfe6ff';
      c.beginPath();
      c.arc(st.x, st.y, st.r, 0, 7);
      c.fill();
    }
    c.globalAlpha = 1;
    /* дальние облака */
    c.fillStyle = 'rgba(210,230,250,0.06)';
    for (i = 0; i < 3; i++) {
      var cx = W - ((s.t * 0.012 + i * 360) % (W + 340)) + 30;
      var cy = 60 + i * 105;
      c.beginPath();
      c.ellipse(cx, cy, 95, 24, 0, 0, 7);
      c.ellipse(cx + 58, cy + 8, 62, 18, 0, 0, 7);
      c.ellipse(cx - 60, cy + 10, 55, 16, 0, 0, 7);
      c.fill();
    }
    /* дальние холмы */
    c.fillStyle = 'rgba(10,32,54,0.75)';
    for (i = 0; i < 5; i++) {
      var hx = W - ((s.t * 0.02 + i * 260) % (W + 420)) - 60;
      c.beginPath();
      c.ellipse(hx, H - 24, 190, 74, 0, Math.PI, 0);
      c.fill();
    }
    /* трубы: градиент + скруглённые крышки + блик */
    for (i = 0; i < s.pipes.length; i++) {
      p = s.pipes[i];
      var pg = c.createLinearGradient(p.x, 0, p.x + FL_PIPE_W, 0);
      pg.addColorStop(0, '#2a5d96');
      pg.addColorStop(0.35, '#3f83c9');
      pg.addColorStop(1, '#234f80');
      c.fillStyle = pg;
      c.fillRect(p.x, 0, FL_PIPE_W, p.top - 2);
      c.fillRect(p.x, p.top + FL_GAP + 2, FL_PIPE_W, H - p.top - FL_GAP - 26);
      /* блик на трубе */
      c.fillStyle = 'rgba(255,255,255,0.10)';
      c.fillRect(p.x + 8, 0, 7, p.top - 2);
      c.fillRect(p.x + 8, p.top + FL_GAP + 2, 7, H - p.top - FL_GAP - 26);
      /* крышки */
      var cg = c.createLinearGradient(p.x - 5, 0, p.x + FL_PIPE_W + 5, 0);
      cg.addColorStop(0, '#1d4470');
      cg.addColorStop(0.4, '#4b92d6');
      cg.addColorStop(1, '#1a3d64');
      c.fillStyle = cg;
      flRoundRect(c, p.x - 5, p.top - 20, FL_PIPE_W + 10, 20, 5);
      c.fill();
      flRoundRect(c, p.x - 5, p.top + FL_GAP, FL_PIPE_W + 10, 20, 5);
      c.fill();
      c.fillStyle = 'rgba(255,255,255,0.14)';
      flRoundRect(c, p.x - 2, p.top - 18, FL_PIPE_W + 4, 5, 2);
      c.fill();
      flRoundRect(c, p.x - 2, p.top + FL_GAP + 2, FL_PIPE_W + 4, 5, 2);
      c.fill();
    }
    /* земля с бегущими полосами */
    var gg = c.createLinearGradient(0, H - 24, 0, H);
    gg.addColorStop(0, '#14344f');
    gg.addColorStop(1, '#081526');
    c.fillStyle = gg;
    c.fillRect(0, H - 24, W, 24);
    c.fillStyle = 'rgba(90,160,220,0.25)';
    var off = (s.t * 0.096) % 46;
    for (i = -1; i < W / 46 + 1; i++) {
      c.fillRect(i * 46 - off, H - 24, 20, 3);
    }
    /* птичка: мягкая тень, плавный наклон, лёгкая пульсация при взмахе */
    var bx = Math.max(W * 0.18, 90);
    c.save();
    c.translate(bx, s.y);
    c.rotate(s.rot);
    var pulse = 1 + s.flash * 0.12;
    c.shadowColor = 'rgba(0,0,0,0.4)';
    c.shadowBlur = 10;
    c.shadowOffsetY = 3;
    if (flBird && flBird.complete && flBird.naturalWidth) {
      c.drawImage(flBird, -23 * pulse, -23 * pulse, 46 * pulse, 46 * pulse);
    } else {
      c.fillStyle = '#7ab3e0';
      c.beginPath();
      c.arc(0, 0, 15, 0, 7);
      c.fill();
    }
    c.restore();
    /* всплывающие +очки */
    c.textAlign = 'left';
    for (i = 0; i < s.floaters.length; i++) {
      var f = s.floaters[i];
      var k = f.t / 900;
      c.globalAlpha = 1 - k * k;
      c.font = 'bold 17px monospace';
      c.fillStyle = '#8be89b';
      c.fillText(f.text, f.x, f.y - k * 46);
    }
    c.globalAlpha = 1;
    /* HUD-плашка */
    c.font = 'bold 17px monospace';
    var hud = '🐦 ' + s.score + '    +' + flEarned;
    var hw = c.measureText(hud).width + 26;
    c.fillStyle = 'rgba(8,14,28,0.55)';
    flRoundRect(c, 10, 10, hw, 30, 15);
    c.fill();
    c.strokeStyle = 'rgba(122,43,216,0.65)';
    c.lineWidth = 1;
    flRoundRect(c, 10, 10, hw, 30, 15);
    c.stroke();
    c.fillStyle = '#e8ecff';
    c.fillText(hud, 23, 31);
    /* экран смерти с плавным затемнением */
    if (s.mode === 'dead') {
      var dk = Math.min(1, (Date.now() - s.deadAt) / 350);
      c.fillStyle = 'rgba(5,10,20,' + (0.55 * dk) + ')';
      c.fillRect(0, 0, W, H);
      c.globalAlpha = dk;
      c.textAlign = 'center';
      c.fillStyle = '#e8d5ff';
      c.font = 'bold 30px monospace';
      c.fillText('ВРЕЗАЛСЯ 😵', W / 2, H / 2 - 14);
      c.font = 'bold 18px monospace';
      c.fillStyle = '#9fc3e8';
      c.fillText('🐦 ' + s.score + '    +' + flEarned + ' очков', W / 2, H / 2 + 22);
      c.globalAlpha = 1;
    }
  }

  function flappyLoop() {
    if (!flappyOn) return;
    var now = performance.now();
    var s = flState;
    if (s && s.last) {
      var dtms = Math.min(now - s.last, 66);
      flappyStep(dtms / 16.667, dtms);
    }
    if (s) s.last = now;
    flappyDraw();
    flRAF = requestAnimationFrame(flappyLoop);
  }

  function toggleFlappy(force) {
    flappyOn = (typeof force === 'boolean') ? force : !flappyOn;
    if (flWin) flWin.style.display = flappyOn ? 'block' : 'none';
    if (flappyBtn) flappyBtn.style.background = flappyOn ? '#7a2bd8' : '#555';
    if (flappyOn) {
      flEarned = 0;
      flappyReset('ready');
      flappyResize();
      cancelAnimationFrame(flRAF);
      flRAF = requestAnimationFrame(flappyLoop);
    } else {
      cancelAnimationFrame(flRAF);
    }
  }

  function buildFlappy() {
    flWin = document.createElement('div');
    flWin.style.cssText = 'position:fixed;inset:0;z-index:2147483640;display:none;' +
      'background:#0a1a30;overflow:hidden;';
    flCanvas = document.createElement('canvas');
    flCanvas.style.cssText = 'display:block;width:100%;max-width:560px;height:100%;' +
      'margin:0 auto;cursor:pointer;touch-action:none;' +
      'box-shadow:0 0 80px rgba(0,0,0,.55);';
    flCtx = flCanvas.getContext('2d');
    flCanvas.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      flappyFlap();
    });
    var close = document.createElement('button');
    close.textContent = '✕';
    close.style.cssText = 'position:absolute;top:8px;right:10px;background:rgba(160,20,30,0.85);color:#fff;' +
      'border:none;border-radius:8px;font-size:13px;padding:5px 11px;cursor:pointer;' +
      'backdrop-filter:blur(2px);';
    close.onclick = function () { toggleFlappy(false); };
    flWin.appendChild(flCanvas);
    flWin.appendChild(close);
    document.body.appendChild(flWin);
    flBird = new Image();
    flBird.src = 'data:image/png;base64,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';
    flKeyH = function (e) {
      if (!flappyOn) return;
      if (e.code === 'Space') {
        e.preventDefault();
        flappyFlap();
      }
      if (e.code === 'Escape') toggleFlappy(false);
    };
    window.addEventListener('keydown', flKeyH);
    flResizeH = function () { if (flappyOn) flappyResize(); };
    window.addEventListener('resize', flResizeH);
    flappyReset('ready');
  }

  /* ---------- 5. Кнопки модальных окон (старт/следующий уровень) ---------- */  var lastClick = {};
  function clickModalButton(text) {
    var container = document.querySelector('.modal-container.displayed');
    if (!container) return false;
    var btns = container.querySelectorAll('.window.modal button');
    for (var i = 0; i < btns.length; i++) {
      var modal = btns[i].closest('.window.modal');
      if (modal && modal.className.indexOf('exit') !== -1) continue;
      if (btns[i].textContent.trim() === text) {
        var now = Date.now();
        if (lastClick[text] && now - lastClick[text] < 2000) return true;
        lastClick[text] = now;
        btns[i].click();
        return true;
      }
    }
    return false;
  }

  /* ---------- 6. Фоновый фарм: события Redux + резервный Worker ---------- */
  var emptyTicks = 0;
  function scheduleFarmTick() {
    if (!running || !store || tickQueued || tickBusy) return;
    tickQueued = true;
    // Microtask не зависит от ограничений таймеров фоновых вкладок.
    Promise.resolve().then(function () {
      tickQueued = false;
      farmTick();
    });
  }
  function farmTick() {
    if (!running || !store || tickBusy) return;
    tickBusy = true;
    try {
      if (hintOn && document.visibilityState === 'visible') updateHint();
      var g0 = store.getState().game;
      if (g0.isGameOver && (goalScore || goalDone)) {
        goalScore = 0;
        goalDone = false;
        if (goalBtn) goalBtn.style.background = '#555';
      }
      if (goalScore && g0.score >= goalScore) goalDone = true;
      if (goalDone && !g0.isGameOver) {
        clickModalButton('Next Level');
        status.textContent = '🏁';
        return;
      }
      var now0 = Date.now();
      if (!farmStats.started) { farmStats.started = now0; farmStats.stage = g0.stage; farmStats.stageTime = now0; }
      if (farmStats.lastTick) {
        var gap = now0 - farmStats.lastTick;
        farmStats.longestGap = Math.max(farmStats.longestGap, gap);
        if (gap > 1500 && now0 - diagnostic.lastGapReport > 1000) {
          diagnostic.lastGapReport = now0;
          logFarm('timer-gap', { ms: gap, visible: document.visibilityState });
        }
      }
      farmStats.lastTick = now0;
      if (typeof g0.stage === 'number' && g0.stage > farmStats.stage) {
        farmStats.levels += g0.stage - farmStats.stage;
        farmStats.stage = g0.stage;
        farmStats.stageTime = now0;
        logFarm('level-up', { stage: g0.stage, levels: farmStats.levels, solved: farmStats.solved });
      } else if (typeof g0.stage === 'number' && g0.stage < farmStats.stage) {
        farmStats.stage = g0.stage;
        farmStats.stageTime = now0;
      }
      if (statsEl && now0 - farmStats.lastStats > 2000) {
        farmStats.lastStats = now0;
        var hours = Math.max((now0 - farmStats.started) / 3600000, 1 / 3600);
        var perHour = Math.round(farmStats.levels / hours);
        var idle = farmStats.lastSolved ? Math.round((now0 - farmStats.lastSolved) / 1000) : 0;
        statsEl.textContent = 'Ур. ' + g0.stage + ' · ' + perHour + ' ур/ч · ' + idle + ' с без ответа';
        statsEl.title = 'Решено: ' + farmStats.solved + '; ожидание: ' + Math.round(farmStats.waitingMs / 1000) + ' с; максимальный разрыв проверок: ' + Math.round(farmStats.longestGap / 1000) + ' с';
      }
      farmSnapshot();
      if (!rateStamp) rateStamp = { t: now0, s: g0.score };
      if (now0 - rateStamp.t >= 3000 && !g0.isGameOver) {
        var rate = Math.round((g0.score - rateStamp.s) / (now0 - rateStamp.t) * 60000);
        rateStamp = { t: now0, s: g0.score };
        status.textContent = rate >= 1000 ? Math.round(rate / 1000) + 'k/м' : rate + '/м';
      }
      // Модальные окна могут появляться до очередного обновления Redux.
      if (now0 - lastModalAttempt > 300) {
        lastModalAttempt = now0;
        if (clickModalButton('Play Game') || clickModalButton('Next Level')) return;
      }
      if (document.querySelector('.modal-container.displayed')) return;
      var g = store.getState().game;
      if (g.isGameOver || g.isTutorial) return;
      if (g.activeProblems.length === 0) {
        if (!farmStats.waitingSince) farmStats.waitingSince = now0;
      } else if (farmStats.waitingSince) {
        farmStats.waitingMs += now0 - farmStats.waitingSince;
        farmStats.waitingSince = 0;
      }
      // Не перезапускаем решение на каждое внутреннее Redux-действие.
      var signature = g.stage + ':' + g.problemsCompleted + ':' + g.activeProblems.map(function (p) {
        return p.id + '=' + p.currentGuess + '/' + p.answer;
      }).join(',');
      // Восстанавливаем генерацию строк, если после очистки доски игра зависла.
      var pendingNow = store.getState().time.pendingActions;
      if (!g.isIntro && !g.isGameOver && g.activeProblems.length === 0 &&
          g.problemsCompleted < linesRequired(g.stage)) {
        if ('add-problem' in pendingNow) {
          // Приостановленные фоновые таймеры игры не должны блокировать очередь.
          tryExecute('add-problem');
        } else if (!farmStageStart) farmStageStart = Date.now();
        else if (Date.now() - farmStageStart > 600) {
          farmStageStart = 0;
          logFarm('board-recovery', { stage: g.stage, completed: g.problemsCompleted });
          beginStage();
        }
      } else farmStageStart = 0;
      if (signature === lastFarmSignature) return;
      lastFarmSignature = signature;
      g.activeProblems.slice().forEach(function (p) {
        if (p.currentGuess !== p.answer) {
          var gc = goalScore ? goalCheckSolve() : 0;
          if (gc === 2) { goalDone = true; return; }
          if (gc === 1) return;
          solve(p);
        }
      });
      g = store.getState().game;
      var pending = store.getState().time.pendingActions;
      if (!g.isIntro && !g.isGameOver && g.activeProblems.length === 0 &&
          g.problemsCompleted < linesRequired(g.stage) && !('add-problem' in pending)) {
        emptyTicks++;
      } else emptyTicks = 0;
      farmTicks++;
    } catch (e) {
      if (Date.now() - lastFarmError > 5000) {
        logFarm('error', { message: String(e && e.message || e).slice(0, 300) });
        console.log('bot error', e); lastFarmError = Date.now();
      }
    } finally { tickBusy = false; }
  }
  function startLoop() {
    // Повторное изменение задержки не должно плодить подписки и Worker.
    if (timer) { clearInterval(timer); timer = null; }
    if (farmWorker) { farmWorker.terminate(); farmWorker = null; }
    if (unsubscribeFarm) { unsubscribeFarm(); unsubscribeFarm = null; }
    if (modalObserver) { modalObserver.disconnect(); modalObserver = null; }
    document.removeEventListener('visibilitychange', scheduleFarmTick);
    if (typeof store.subscribe === 'function') {
      unsubscribeFarm = store.subscribe(function () {
        if (running) scheduleFarmTick();
      });
    }
    // Worker обеспечивает резервные проверки, когда вкладка неактивна.
    // Браузер всё равно может ограничивать Worker или полностью усыпить вкладку.
    try {
      var workerCode = 'var timer;onmessage=function(e){if(e.data===\"start\"){clearInterval(timer);timer=setInterval(function(){postMessage(\"tick\")},100)}else if(e.data===\"stop\"){clearInterval(timer);close()}}';
      var workerURL = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
      farmWorker = new Worker(workerURL);
      URL.revokeObjectURL(workerURL);
      farmWorker.onmessage = function () { farmTick(); };
      farmWorker.postMessage('start');
    } catch (e) { farmWorker = null; console.log('Worker недоступен; используется обычный таймер', e); }
    timer = setInterval(function () {
      if (running) farmTick();
      else if (hintOn && document.visibilityState === 'visible') updateHint();
    }, 250);
    modalObserver = new MutationObserver(function (records) {
      if (!running) return;
      // Изменения игрового поля обрабатывает Redux; DOM нужен только для модальных окон.
      for (var i = 0; i < records.length; i++) {
        var target = records[i].target;
        if (target && target.closest && target.closest('.modal-container')) {
          scheduleFarmTick();
          break;
        }
        var added = records[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var node = added[j];
          if (node.nodeType === 1 && (node.matches('.modal-container') || node.querySelector('.modal-container'))) {
            scheduleFarmTick();
            return;
          }
        }
      }
    });
    modalObserver.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('visibilitychange', scheduleFarmTick);
  }

  /* ---------- 7. Панель управления ---------- */
  function mkBtn(text, bg) {
    var b = document.createElement('button');
    b.textContent = text;
    b.style.cssText = 'padding:6px 10px;border:none;border-radius:6px;font-size:13px;' +
      'background:' + bg + ';color:#fff;cursor:pointer;flex-shrink:0;';
    return b;
  }
  function makeDraggable(el, handle) {
    var sx, sy, ox, oy, moved;
    handle.addEventListener('pointerdown', function (e) {
      moved = false;
      sx = e.clientX; sy = e.clientY;
      var r = el.getBoundingClientRect();
      ox = r.left; oy = r.top;
      el.style.left = ox + 'px';
      el.style.top = oy + 'px';
      el.style.bottom = 'auto';
      el.style.right = 'auto';
      try { handle.setPointerCapture(e.pointerId); } catch (err) {}
    });
    handle.addEventListener('pointermove', function (e) {
      if (sx === undefined) return;
      if (!e.buttons && e.pointerType === 'mouse') return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
      if (moved) {
        el.style.left = (ox + dx) + 'px';
        el.style.top = (oy + dy) + 'px';
      }
    });
    handle.addEventListener('pointerup', function () { sx = undefined; });
    handle.__wasDragged = function () { return moved; };
  }

  /* ---------- Всплывающие настройки: одновременно открыто только одно окно ---------- */
  var settingsPopup = null;
  var popupOutside = null;
  var popupResize = null;
  function closeSettingsPopup() {
    if (popupOutside) document.removeEventListener('pointerdown', popupOutside, true);
    if (popupResize) window.removeEventListener('resize', popupResize);
    popupOutside = popupResize = null;
    if (settingsPopup) settingsPopup.remove();
    settingsPopup = null;
  }
  function showSettingsPopup(anchor, title, value, min, max, step, suffix, onChange) {
    closeSettingsPopup();
    var popup = document.createElement('div');
    settingsPopup = popup;
    popup.style.cssText = 'position:fixed;z-index:2147483647;box-sizing:border-box;width:210px;' +
      'background:#172338;border:1px solid #7050b2;border-radius:12px;padding:12px;' +
      'color:#fff;box-shadow:0 7px 25px #0009;font:13px Arial,sans-serif;' +
      'touch-action:manipulation;user-select:none;-webkit-user-select:none;';
    var heading = document.createElement('div');
    heading.textContent = title;
    heading.style.cssText = 'text-align:center;font-weight:bold;margin-bottom:10px;';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';
    var output = document.createElement('strong');
    output.style.cssText = 'min-width:76px;text-align:center;font: bold 17px monospace;';
    function refresh() { output.textContent = value + suffix; }
    refresh();
    function makeHold(sign) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = sign < 0 ? '−' : '+';
      btn.style.cssText = 'width:43px;height:39px;border:1px solid #8066bd;border-radius:8px;' +
        'background:#354b72;color:white;font:bold 23px Arial;cursor:pointer;touch-action:none;';
      var wait = null, repeat = null;
      function stop() { clearTimeout(wait); clearInterval(repeat); wait = repeat = null; }
      function change() {
        var next = Math.max(min, Math.min(max, value + sign * step));
        if (next === value) return;
        value = next; refresh(); onChange(value);
      }
      btn.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault(); stop();
        try { btn.setPointerCapture(e.pointerId); } catch (err) {}
        change();
        wait = setTimeout(function () { repeat = setInterval(change, 50); }, 300);
      });
      btn.addEventListener('pointerup', stop);
      btn.addEventListener('pointercancel', stop);
      btn.addEventListener('lostpointercapture', stop);
      btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      return btn;
    }
    row.appendChild(makeHold(-1)); row.appendChild(output); row.appendChild(makeHold(1));
    popup.appendChild(heading); popup.appendChild(row);
    document.body.appendChild(popup);
    function position() {
      if (!popup.isConnected || !anchor.isConnected) return;
      var r = anchor.getBoundingClientRect();
      popup.style.left = Math.max(8, Math.min(window.innerWidth - popup.offsetWidth - 8,
        r.left + r.width / 2 - popup.offsetWidth / 2)) + 'px';
      popup.style.top = (r.top >= popup.offsetHeight + 10
        ? r.top - popup.offsetHeight - 8
        : Math.min(window.innerHeight - popup.offsetHeight - 8, r.bottom + 8)) + 'px';
    }
    position();
    popupResize = position;
    window.addEventListener('resize', popupResize);
    popupOutside = function (e) {
      if (!popup.contains(e.target) && !anchor.contains(e.target)) closeSettingsPopup();
    };
    document.addEventListener('pointerdown', popupOutside, true);
  }
  function showDelaySettings() {
    showSettingsPopup(toggleBtn, 'Задержка автофарма', FARM_DELAY, 5, 1000, 5, ' мс', function (v) {
      FARM_DELAY = v;
      localStorage.setItem('blxckFarmDelay', String(v));
      logFarm('delay-change', { delay: v });
      if (timer) startLoop();
    });
  }
  function showHintSettings(button) {
    showSettingsPopup(button, 'Прозрачность подсказки', HINT_OPACITY, 0, 100, 5, '%', function (v) {
      HINT_OPACITY = v;
      localStorage.setItem('blxckHintOpacity', String(v));
      if (hintEl) hintEl.style.opacity = String(v / 100);
    });
  }

  function buildUI() {
    if (!document.getElementById('blxck-style')) {
      var st = document.createElement('style');
      st.id = 'blxck-style';
      st.textContent =
        '.blxck span{display:inline-block;font:bold 13px monospace;color:#8a2be2;' +
        'animation:blxckGlow 1.8s ease-in-out infinite;}' +
        '.blxck span:nth-child(3){animation:blxckGlow 1.8s ease-in-out infinite,blxckFlick 4.5s step-end infinite;}' +
        '@keyframes blxckGlow{0%,100%{color:#6a1fb8;text-shadow:0 0 3px #7a2bd8;transform:translateY(0);}' +
        '50%{color:#e6c2ff;text-shadow:0 0 6px #c266ff,0 0 14px #a64dff,0 0 22px #8a2be2;transform:translateY(-1px);}}' +
        '@keyframes blxckFlick{0%,90%,100%{opacity:1;}92%{opacity:.15;}94%{opacity:1;}96%{opacity:.35;}}' +
        '.blxck-boom{position:fixed;font-size:64px;z-index:2147483647;pointer-events:none;' +
        'animation:blxckBoom .6s ease-out forwards;user-select:none;}' +
        '@keyframes blxckBoom{0%{transform:scale(.3) rotate(-12deg);opacity:1;}' +
        '55%{transform:scale(1.6) rotate(6deg);opacity:.95;}100%{transform:scale(2.3);opacity:0;}}' +
        '@keyframes blxckShake{0%,100%{transform:translate(0,0);}20%{transform:translate(-5px,3px);}' +
        '40%{transform:translate(5px,-3px);}60%{transform:translate(-4px,-2px);}80%{transform:translate(4px,2px);}}' +
        '@keyframes blxckNo{0%,100%{transform:translateX(0);}25%{transform:translateX(-4px);}' +
        '75%{transform:translateX(4px);}}' +
        '.blxck-det .plunger{transition:transform .15s ease-in;}' +
        '@keyframes blxckSwing{0%{transform:rotate(0);}30%{transform:rotate(-35deg);}' +
        '60%{transform:rotate(50deg);}100%{transform:rotate(0);}}';
      document.head.appendChild(st);
    }

    panel = document.createElement('div');
    panel.style.cssText = 'position:fixed;bottom:44px;left:10px;z-index:2147483647;' +
      'background:rgba(20,20,32,0.92);border-radius:10px;padding:7px 8px;' +
      'display:flex;flex-direction:column;gap:5px;align-items:flex-start;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.5);' +
      'width:max-content;white-space:nowrap;' +
      'touch-action:none;user-select:none;-webkit-user-select:none;';

    var grip = document.createElement('span');
    grip.textContent = '⠿';
    grip.style.cssText = 'color:#888;font-size:15px;cursor:move;padding:0 2px;touch-action:none;flex-shrink:0;';

    status = document.createElement('span');
    status.textContent = '…';
    status.style.cssText = 'color:#8f8;font-size:12px;min-width:26px;flex-shrink:0;';
    statsEl = document.createElement('span');
    statsEl.style.cssText = 'color:#aee;font-size:11px;max-width:240px;white-space:normal;line-height:1.3;';
    statsEl.textContent = 'Статистика появится после запуска';

    toggleBtn = mkBtn('▶ Бот', '#2a7d2a');
    var hintBtn = mkBtn('💡', '#555');
    goalBtn = mkBtn('🎯', '#555');
    var detBtn = mkBtn('🧨', '#555');
    var eggBtn = mkBtn('🍆', '#555');
    flappyBtn = mkBtn('🎮', '#555');
    var hideBtn = mkBtn('—', '#555');
    var killBtn = mkBtn('✕', '#c00');
    var logBtn = mkBtn('📋 Лог', '#345');
    logBtn.title = 'Сохранить диагностический JSON для анализа скорости';
    logBtn.onclick = exportFarmLog;

    toggleBtn.onclick = function () {
      running = !running;
      toggleBtn.textContent = running ? '⏸ Пауза' : '▶ Бот';
      toggleBtn.style.background = running ? '#b8860b' : '#2a7d2a';
      status.textContent = running ? 'бот' : '⏸';
      status.style.color = running ? '#8f8' : '#fa0';
      logFarm(running ? 'resume' : 'pause', { stage: store && store.getState().game.stage });
      if (running && store) {
        var now = Date.now();
        rateStamp = { t: now, s: store.getState().game.score };
        farmStats = { started: now, stage: store.getState().game.stage, stageTime: now, levels: 0, solved: 0, lastSolved: now, lastTick: 0, longestGap: 0, waitingSince: 0, waitingMs: 0, lastStats: 0 };
        lastFarmSignature = '';
        scheduleFarmTick();
      }
      if (running) showDelaySettings(); else closeSettingsPopup();
    };
    goalBtn.onclick = function () {
      var v = window.prompt('На каком счёте закончить игру? Очки начисляются порциями и кратны 25 (на 1 уровне — сотнями), поэтому бот остановится на ближайшем значении НЕ ВЫШЕ цели и даст игре завершиться — рекорд запишется. (0 — без цели)', goalScore || '');
      if (v === null) return;
      var n = parseInt(v, 10);
      goalScore = (isNaN(n) || n <= 0) ? 0 : n;
      goalDone = false;
      goalBtn.style.background = goalScore ? '#7a2bd8' : '#555';
    };
    detBtn.onclick = function () {
      detOn = !detOn;
      detBtn.style.background = detOn ? '#7a2bd8' : '#555';
      detEl.style.display = detOn ? 'block' : 'none';
    };
    eggBtn.onclick = function () {
      eggOn = !eggOn;
      eggBtn.style.background = eggOn ? '#7a2bd8' : '#555';
      eggEl.style.display = eggOn ? 'block' : 'none';
    };
    flappyBtn.onclick = function () { toggleFlappy(); };
    hintBtn.onclick = function () {
      hintOn = !hintOn;
      hintBtn.style.background = hintOn ? '#7a2bd8' : '#555';
      hintEl.style.display = hintOn ? 'block' : 'none';
      if (!hintOn) { hintEl.textContent = ''; closeSettingsPopup(); }
      else showHintSettings(hintBtn);
    };
    hideBtn.onclick = function () {
      closeSettingsPopup();
      panel.style.display = 'none';
      dot.style.display = 'block';
    };
    killBtn.onclick = function () { destroy(); };

    /* Верхний ряд — основное, нижний — мемные функции */
    var rowMain = document.createElement('div');
    rowMain.style.cssText = 'display:flex;gap:6px;align-items:center;flex-shrink:0;';
    var rowMeme = document.createElement('div');
    rowMeme.style.cssText = 'display:flex;gap:6px;align-items:center;flex-shrink:0;' +
      'border-top:1px solid rgba(122,43,216,.4);padding-top:5px;';

    rowMain.appendChild(grip);
    rowMain.appendChild(status);
    rowMain.appendChild(toggleBtn);
    rowMain.appendChild(hintBtn);
    rowMain.appendChild(goalBtn);
    rowMain.appendChild(hideBtn);
    rowMain.appendChild(killBtn);
    rowMeme.appendChild(detBtn);
    rowMeme.appendChild(eggBtn);
    rowMeme.appendChild(flappyBtn);
    panel.appendChild(rowMain);
    panel.appendChild(rowMeme);

    var neon = document.createElement('div');
    neon.className = 'blxck';
    neon.style.cssText = 'position:absolute;left:50%;top:100%;transform:translateX(-50%);' +
      'margin-top:5px;pointer-events:none;letter-spacing:4px;user-select:none;';
    var word = 'BLXCK';
    for (var li = 0; li < word.length; li++) {
      var sp = document.createElement('span');
      sp.textContent = word[li];
      sp.style.animationDelay = (li * 0.25) + 's';
      neon.appendChild(sp);
    }
    panel.appendChild(neon);

    /* Невидимая зона в левом нижнем углу: тап по углу открывает панель */
    dot = document.createElement('div');
    dot.style.cssText = 'position:fixed;bottom:0;left:0;z-index:2147483647;width:48px;height:48px;' +
      'display:none;opacity:0;background:transparent;touch-action:none;' +
      'user-select:none;-webkit-user-select:none;';
    dot.onclick = function () {
      dot.style.display = 'none';
      panel.style.display = 'flex';
    };

    hintEl = document.createElement('div');
    hintEl.style.cssText = 'position:fixed;bottom:3px;right:7px;z-index:2147483646;' +
      'font:bold 11px monospace;color:#ccc;opacity:' + (HINT_OPACITY / 100) + ';letter-spacing:1px;' +
      'pointer-events:none;user-select:none;-webkit-user-select:none;display:none;';
    document.body.appendChild(hintEl);

    /* Детонатор: красный ящик с плунжером, как на картинке */
    detEl = document.createElement('div');
    detEl.className = 'blxck-det';
    detEl.style.cssText = 'position:fixed;bottom:60px;right:14px;z-index:2147483646;display:none;' +
      'cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none;' +
      'filter:drop-shadow(0 3px 5px rgba(0,0,0,.55));opacity:0.95;';
    detEl.innerHTML =
      '<svg width="62" height="84" viewBox="0 0 62 84">' +
      '<g class="plunger">' +
      '<rect x="5" y="4" width="52" height="11" rx="5.5" fill="#141414"/>' +
      '<rect x="26" y="1" width="10" height="17" rx="4" fill="#2b2b2b"/>' +
      '<rect x="29" y="15" width="4" height="25" fill="#bdbdbd"/>' +
      '</g>' +
      '<rect x="25" y="37" width="12" height="7" rx="2" fill="#333"/>' +
      '<rect x="6" y="43" width="50" height="38" rx="4" fill="#c01818" stroke="#7d0f0f" stroke-width="2"/>' +
      '<circle cx="15" cy="53" r="2.3" fill="#7d0f0f"/><circle cx="47" cy="53" r="2.3" fill="#7d0f0f"/>' +
      '<circle cx="15" cy="72" r="2.3" fill="#7d0f0f"/><circle cx="47" cy="72" r="2.3" fill="#7d0f0f"/>' +
      '</svg>';
    detPlunger = detEl.querySelector('.plunger');
    detEl.onclick = function () {
      if (detEl.__wasDragged && detEl.__wasDragged()) return;
      detonate();
    };
    document.body.appendChild(detEl);

    /* Баклажан-бита: мемное забивание нижней строки */
    eggEl = document.createElement('div');
    eggEl.textContent = '🍆';
    eggEl.style.cssText = 'position:fixed;bottom:150px;right:28px;z-index:2147483646;display:none;' +
      'font-size:52px;cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none;' +
      'transform-origin:50% 90%;filter:drop-shadow(0 3px 5px rgba(0,0,0,.55));';
    eggEl.onclick = function () {
      if (eggEl.__wasDragged && eggEl.__wasDragged()) return;
      smash();
    };
    document.body.appendChild(eggEl);

    buildFlappy();

    makeDraggable(panel, grip);
    makeDraggable(detEl, detEl);
    makeDraggable(eggEl, eggEl);

    panel.appendChild(statsEl);
    panel.appendChild(logBtn);
    document.body.appendChild(panel);
    document.body.appendChild(dot);

    /* По умолчанию панель скрыта — работает только невидимый угол */
    panel.style.display = 'none';
    dot.style.display = 'block';
  }

  function destroy() {
    closeSettingsPopup();
    running = false;
    if (timer) clearInterval(timer);
    delete window.__binaryBotExportLog;
    if (farmWorker) { farmWorker.postMessage('stop'); farmWorker.terminate(); farmWorker = null; }
    if (unsubscribeFarm) { unsubscribeFarm(); unsubscribeFarm = null; }
    if (modalObserver) { modalObserver.disconnect(); modalObserver = null; }
    document.removeEventListener('visibilitychange', scheduleFarmTick);
    if (panel) panel.remove();
    if (dot) dot.remove();
    if (hintEl) hintEl.remove();
    if (detEl) detEl.remove();
    if (eggEl) eggEl.remove();
    if (flWin) flWin.remove();
    cancelAnimationFrame(flRAF);
    if (flKeyH) window.removeEventListener('keydown', flKeyH);
    if (flResizeH) window.removeEventListener('resize', flResizeH);
    var st = document.getElementById('blxck-style');
    if (st) st.remove();
    window.__binaryBot = false;
    console.log('Binary Bot выключен');
  }
  window.__binaryBotStop = destroy;

  /* ---------- 8. Загрузка: ждём, пока игра отрисуется ---------- */
  var bootTries = 0;
  var uiBuilt = false;
  var bootTimer = setInterval(function () {
    try {
      if (!window.__binaryBot) { clearInterval(bootTimer); return; }
      if (!document.body) return;
      if (!uiBuilt) { buildUI(); uiBuilt = true; }
      var s = findStore();
      if (s) {
        store = s;
        window.__binaryStore = s;
        clearInterval(bootTimer);
        status.textContent = '⏸';
        status.style.color = '#fa0';
        startLoop();
        console.log('%cBinary Bot готов (на паузе). Тап по левому нижнему УГЛУ экрана открывает панель. ▶ — старт, 💡 — подсказка, 🎯 — стоп-цель, 🧨 — детонатор, 🍆 — забить нижний ряд, 🎮 — Flappy СибГУТИ на весь экран (труба = решённый ряд), — — свернуть, ✕ — выключить.', 'color: green; font-weight: bold');
      } else if (++bootTries > 100) {
        clearInterval(bootTimer);
        status.textContent = '!';
        status.style.color = '#f66';
        alert('Binary Bot: не удалось подключиться к игре. Обновите страницу.');
        window.__binaryBot = false;
      }
    } catch (e) { console.log('bot boot error', e); }
  }, 400);
})();