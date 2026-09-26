// ==UserScript==
// @name         Binary Game Bot (reconstruction 1.0)
// @namespace    https://netacad.sadlab.su/
// @version      1.0
// @description  Reconstructed historical milestone; not an original release
// @match        https://netacad.sadlab.su/games/binary/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  if (window.__binaryBotReconstruction) return;
  window.__binaryBotReconstruction = true;

  function findStore() {
    var root = document.getElementById('reactRoot');
    if (!root) return null;
    var keys = Object.keys(root), fiber = null;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], v = root[k];
      if (k === '_reactRootContainer') { fiber = v._internalRoot.current; break; }
      if (k.indexOf('__reactContainer') === 0) { fiber = v.current || v; break; }
      if (k.indexOf('__reactInternalInstance') === 0) { fiber = v; break; }
    }
    if (!fiber) return null;
    while (fiber.return) fiber = fiber.return;
    var stack = [fiber];
    while (stack.length) {
      var f = stack.pop();
      if (!f) continue;
      if (f.memoizedProps && f.memoizedProps.store && typeof f.memoizedProps.store.getState === 'function') return f.memoizedProps.store;
      if (f.stateNode && f.stateNode.store && typeof f.stateNode.store.getState === 'function') return f.stateNode.store;
      if (f.child) stack.push(f.child);
      if (f.sibling) stack.push(f.sibling);
    }
    return null;
  }

  var store = null, running = false, timer = null;
  function queue(action) {
    store.dispatch({ type: 'QUEUE_ACTION', payload: action });
    setTimeout(function () { tryExecute(action.id); }, action.delay);
  }
  function tryExecute(id) {
    store.dispatch({ type: 'UPDATE_TIME' });
    var pending = store.getState().time.pendingActions;
    if (pending[id]) {
      store.dispatch({ type: 'EXECUTE_ACTION', payload: id });
    }
  }
  function solve(p) {
    if (!store || p.currentGuess === p.answer) return;
    var bits = p.answer.toString(2).padStart(8, '0');
    var guess = p.currentGuess.toString(2).padStart(8, '0');
    for (var i = 0; i < 8; i++) {
      if (bits[i] !== guess[i]) store.dispatch({ type: 'TOGGLE_BIT', payload: { id: p.id, bit: 7 - i } });
    }
    store.dispatch({ type: 'SUBMIT_ANSWER', payload: p.id });
  }

  function tick() {
    if (!running || !store) return;
    try {
      var g = store.getState().game;
      if (g.isGameOver || g.isTutorial || g.isIntro) return;
      g.activeProblems.slice().forEach(function (p) { if (p.currentGuess !== p.answer) solve(p); });
    } catch (e) { console.log('reconstruction bot error', e); }
  }

  var panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;bottom:20px;left:12px;z-index:2147483647;background:#202030;color:white;padding:8px;border-radius:8px;display:flex;gap:6px;';
  function button(label, handler) {
    var b = document.createElement('button');
    b.textContent = label; b.onclick = handler; panel.appendChild(b); return b;
  }
  var toggle = button('▶ Бот', function () {
    running = !running;
    toggle.textContent = running ? '⏸ Пауза' : '▶ Бот';
  });

  var boot = setInterval(function () {
    if (store) return;
    store = findStore();
    if (store) {
      clearInterval(boot);
      document.body.appendChild(panel);
      timer = setInterval(tick, 100);
    }
  }, 400);
})();
