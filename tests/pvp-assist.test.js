import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as rules from '../src/shared/rules.js';
import * as sandbox from '../src/shared/sandbox.js';
import * as analysis from '../src/shared/analysis.js';
import * as ai from '../web/ai-game.js';
import * as roomControls from '../web/room-controls.js';

const [appSource, html] = await Promise.all([
  readFile(new URL('../web/app.js', import.meta.url), 'utf8'),
  readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
]);
// Execute the production application's handlers, without requiring Node's
// experimental VM module flag. Only static module resolution is substituted.
const executableApp = appSource.replace(
  /^import\s+\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2;/gm,
  (_statement, names, _quote, path) => `const {${names}} = dependencies[${JSON.stringify(path)}];`,
);
const p = (x, y) => ({ x, y });
const redMove = { from: p(0, 6), to: p(0, 5) };
const otherRedMove = { from: p(2, 6), to: p(2, 5) };
const blackMove = { from: p(0, 3), to: p(0, 4) };
const flush = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));
const response = (data, ok = true) => ({ ok, json: async () => data });

class Element {
  children = [];
  listeners = new Map();
  attributes = new Map();
  style = {};
  className = '';
  textContent = '';
  value = '';
  hidden = false;
  disabled = false;
  checked = false;
  isConnected = true;
  classList = {
    toggle: (name, enabled) => {
      const names = new Set(this.className.split(' ').filter(Boolean));
      if (enabled ?? !names.has(name)) names.add(name);
      else names.delete(name);
      this.className = [...names].join(' ');
    },
  };
  constructor(id, document) { this.id = id; this.document = document; }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  dispatch(type) {
    for (const callback of this.listeners.get(type) || []) callback({ target: this, preventDefault() {} });
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelector(selector) {
    assert.equal(selector, '.result-card', `Unimplemented DOM selector: ${selector}`);
    return this.card ||= new Element('result-card', this.document);
  }
  contains(element) { return element === this || this.children.some((child) => child.contains(element)); }
  matches() { return true; }
  getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 200 }; }
  focus() { this.document.activeElement = this; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

async function fixture(t, { serverInfo = { addresses: [] } } = {}) {
  const elements = new Map();
  const document = {
    activeElement: null,
    getElementById: (id) => {
      assert.ok(elements.has(id), `Application references missing HTML element #${id}`);
      return elements.get(id);
    },
    createElement: (tag) => new Element(tag, document),
  };
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const [, tag, attributes, id] = match;
    const element = new Element(id, document);
    for (const property of ['hidden', 'disabled', 'checked']) element[property] = new RegExp(`\\b${property}(?:\\s|$|=)`).test(attributes);
    element.value = attributes.match(/\bvalue="([^"]*)"/)?.[1] || '';
    if (tag === 'select') {
      element.value = html.slice(match.index + match[0].length).match(/<option\b[^>]*value="([^"]*)"/)?.[1] || '';
    }
    elements.set(id, element);
  }
  const requests = [];
  const fetch = async (url, options) => {
    if (url === '/api/server-info') return response(serverInfo);
    if (url === '/api/ai/info') return response({ name: 'Pikafish', available: true });
    assert.equal(url, '/api/ai/move');
    return new Promise((resolve) => {
      // Deliberately allow late responses despite AbortSignal so cancellation
      // tests cover a reply already in transit as well as normal fetch aborts.
      requests.push({ options, body: JSON.parse(options.body), resolve, settled: false });
    });
  };
  const sockets = [];
  class Socket {
    static OPEN = 1;
    readyState = 0;
    listeners = new Map();
    sent = [];
    constructor(url) { this.url = url; sockets.push(this); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    send(data) { this.sent.push(JSON.parse(data)); }
    open() { this.readyState = Socket.OPEN; this.listeners.get('open')?.({}); }
    receive(data) { this.listeners.get('message')?.({ data: JSON.stringify(data) }); }
    close() { this.readyState = 3; this.listeners.get('close')?.({}); }
  }
  const storage = new Map();
  const timers = new Map();
  let timerId = 0;
  let elapsed = 0;
  const intervals = [];
  let boardView;
  const dependencies = {
    '/shared/rules.js': rules,
    '/shared/sandbox.js': sandbox,
    '/shared/analysis.js': analysis,
    '/ai-game.js': { ...ai, createAiSearch: (options = {}) => ai.createAiSearch({ ...options, fetchImpl: fetch }) },
    '/room-controls.js': roomControls,
    '/board.js': { renderBoard: (_element, options) => { boardView = options; } },
    '/game-tools.js': { renderCaptured() {} },
  };
  runInNewContext(executableApp, {
    dependencies, document, fetch, WebSocket: Socket, URL, AbortSignal, AbortController, structuredClone,
    performance: { now: () => elapsed },
    window: { addEventListener() {}, innerWidth: 1200, innerHeight: 900 },
    MutationObserver: class { observe() {} },
    location: { origin: 'http://localhost:3000' },
    sessionStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    setInterval(callback) { intervals.push(callback); },
  }, { filename: 'web/app.js' });
  const app = {
    requests, sockets, timers,
    advance: (ms) => { elapsed += ms; for (const callback of intervals) callback(); },
    setServerInfo: (info) => { serverInfo = info; },
    element: (id) => document.getElementById(id),
    get game() { return boardView.game; },
    get canSelect() { return boardView.canSelect; },
    click(id, { force = false } = {}) {
      const element = document.getElementById(id);
      if (force || (!element.disabled && !element.hidden)) element.dispatch('click');
    },
    move(move) { boardView.onClick(move.from); boardView.onClick(move.to); },
    async reply(index, data, ok = true) {
      const request = requests[index];
      assert.ok(request, `Expected search request ${index}`);
      request.settled = true;
      request.resolve(response(data, ok));
      await flush();
    },
    async room({ side = 'red', game = rules.createInitialGame(), revision = 29, started = true, pendingAction = null } = {}) {
      app.click('create');
      const socket = sockets.at(-1);
      assert.ok(socket, 'Create-room UI must open a socket');
      socket.open();
      socket.receive({ type: 'seat', side, code: 'ABCDEF', token: 'test-seat' });
      const room = {
        code: 'ABCDEF', revision, game, players: { red: true, black: true }, pendingAction,
        clock: { started, runningSide: game.turn, remainingMs: { red: 600000, black: 600000 }, initialMs: { red: 600000, black: 600000 } },
      };
      socket.receive({ type: 'state', room });
      await flush();
      return { socket, room };
    },
  };
  t.after(async () => {
    for (const request of requests) if (!request.settled) request.resolve(response({ error: 'Test finished' }, false));
    await flush();
  });
  await flush();
  return app;
}

test('LAN UI identifies the server adapters, separates VPNs and replaces stale addresses on refresh', async (t) => {
  const app = await fixture(t, { serverInfo: { candidates: [
    { url: 'http://10.24.33.144:3000', interfaceName: 'WLAN', recommended: true, kind: 'lan', accessed: true },
    { url: 'http://26.45.156.217:3000', interfaceName: 'Radmin VPN', kind: 'virtual' },
  ] } });
  const address = app.element('addresses').children[0].children[0];
  assert.match(address.textContent, /WLAN.*优先尝试.*当前访问路径/);
  assert.equal(address.children[0].value, 'http://10.24.33.144:3000');
  assert.equal(address.children[0].readOnly, true);
  assert.equal(app.element('other-networks').hidden, false);
  assert.equal(app.element('other-addresses').children.length, 1);
  app.setServerInfo({ candidates: [{ url: 'http://192.168.1.5:45000', interfaceName: 'WLAN', recommended: true, kind: 'lan' }] });
  app.click('refresh-addresses');
  await flush();
  assert.equal(app.element('addresses').children.length, 1);
  assert.equal(app.element('addresses').children[0].children[0].children[0].value, 'http://192.168.1.5:45000');
  assert.equal(app.element('other-addresses').children.length, 0);
  assert.equal(app.element('other-networks').hidden, true);
  assert.equal(app.element('refresh-addresses').disabled, false);
});

test('connection check uses a separate seatless socket and does not disconnect an existing room', async (t) => {
  const app = await fixture(t);
  const { socket: roomSocket } = await app.room();
  app.element('server').value = 'http://10.24.33.144:45678/';
  app.click('check-connection');
  const probe = app.sockets.at(-1);
  assert.notEqual(probe, roomSocket);
  assert.equal(probe.url, 'ws://10.24.33.144:45678/ws');
  assert.equal(app.element('check-connection').disabled, true);
  probe.open();
  assert.deepEqual(probe.sent, [], 'The check must not create, join or claim a seat');
  assert.equal(probe.readyState, 3);
  assert.equal(roomSocket.readyState, 1);
  assert.equal(app.element('check-connection').disabled, false);
  assert.match(app.element('connection-check-status').textContent, /可达.*只证明当前电脑/);
});

test('failed and timed-out connection checks preserve actionable errors after the socket closes', async (t) => {
  const app = await fixture(t);
  app.element('server').value = 'http://26.45.156.217:3000';
  app.click('check-connection');
  app.sockets.at(-1).listeners.get('error')({});
  assert.match(app.element('connection-check-status').textContent, /26\.45\.156\.217:3000.*连接失败.*防火墙/);
  assert.equal(app.element('check-connection').disabled, false);
  app.element('server').value = 'http://10.32.253.250:45000';
  app.click('check-connection');
  [...app.timers.values()].at(-1)();
  assert.equal(app.sockets.at(-1).readyState, 3);
  assert.match(app.element('connection-check-status').textContent, /检测超时.*10\.32\.253\.250:45000/);
  assert.equal(app.element('check-connection').disabled, false);
  app.click('create');
  const joinSocket = app.sockets.at(-1);
  joinSocket.listeners.get('error')({});
  joinSocket.close();
  assert.match(app.element('connection-check-status').textContent, /10\.32\.253\.250:45000.*连接失败/);
});

test('local PvP assistance plays exactly one legal move and leaves the next player in control', async (t) => {
  const app = await fixture(t);
  assert.equal(app.element('ai-assist').disabled, false);
  app.click('ai-assist');
  assert.match(app.element('ai-assist').textContent, /取消/);
  assert.deepEqual(app.requests[0].body, { history: [] });
  await app.reply(0, { move: redMove });
  assert.equal(app.game.history.length, 1);
  assert.equal(app.game.turn, 'black');
  assert.deepEqual(plain(app.game.history[0].to), redMove.to);
  assert.equal(app.requests.length, 1, 'Assistance must not become a continuous AI opponent');
  assert.equal(app.canSelect, true);
  assert.match(app.element('ai-assist').textContent, /AI 帮我走一步/);
});

test('a second click cancels assistance and discards a late response', async (t) => {
  const app = await fixture(t);
  app.click('ai-assist');
  assert.equal(app.element('ai-assist').disabled, false, 'Cancellation must remain clickable');
  app.click('ai-assist');
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].options.signal.aborted, true);
  await app.reply(0, { move: redMove });
  assert.equal(app.game.history.length, 0);
  assert.match(app.element('ai-assist').textContent, /AI 帮我走一步/);
});

test('manual play remains available during analysis and wins over the late AI answer', async (t) => {
  const app = await fixture(t);
  app.click('ai-assist');
  assert.equal(app.canSelect, true);
  app.move(otherRedMove);
  assert.equal(app.game.history.length, 1);
  await app.reply(0, { move: redMove });
  assert.equal(app.game.history.length, 1);
  assert.deepEqual(plain(app.game.history[0].to), otherRedMove.to);
});

test('restarting an identical initial position invalidates an in-flight answer', async (t) => {
  const app = await fixture(t);
  app.click('ai-assist');
  app.click('restart');
  await app.reply(0, { move: redMove });
  assert.equal(app.game.history.length, 0);
  assert.equal(app.element('ai-assist').disabled, false);
});

test('sandbox disables PvP assistance and a round trip cannot revive an old answer', async (t) => {
  const app = await fixture(t);
  app.click('ai-assist');
  app.click('sandbox-toggle');
  assert.ok(app.element('ai-assist').hidden || app.element('ai-assist').disabled);
  app.click('ai-assist');
  assert.equal(app.requests.length, 1);
  app.click('sandbox-toggle');
  await app.reply(0, { move: redMove });
  assert.equal(app.game.history.length, 0);
});

test('AI opponent mode disables assistance and discards an answer from the prior local game', async (t) => {
  const app = await fixture(t);
  app.click('ai-assist');
  app.element('ai-side').value = 'red';
  app.click('ai-start');
  assert.ok(app.element('ai-assist').hidden || app.element('ai-assist').disabled);
  app.click('ai-assist');
  assert.equal(app.requests.length, 1);
  app.click('local');
  await app.reply(0, { move: redMove });
  assert.equal(app.game.history.length, 0);
});

test('online assistance uses the current revision and waits for the normal server move response', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room();
  app.click('ai-assist');
  await app.reply(0, { move: redMove });
  assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), [{ type: 'move', ...redMove, revision: room.revision }]);
  assert.equal(app.game.history.length, 0, 'Online moves must await authoritative state');
  assert.equal(app.element('ai-assist').disabled, true);
  const nextGame = rules.applyMove(room.game, redMove.from, redMove.to).game;
  socket.receive({ type: 'state', room: { ...room, revision: room.revision + 1, game: nextGame } });
  assert.equal(app.game.history.length, 1);
  assert.equal(app.element('ai-assist').disabled, true, 'It is now the opponent turn');
  assert.equal(app.requests.length, 1);
});

test('online revision changes discard a stale answer even when the board is identical', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room();
  app.click('ai-assist');
  socket.receive({ type: 'state', room: { ...room, revision: room.revision + 1 } });
  await app.reply(0, { move: redMove });
  assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), []);
  assert.equal(app.game.history.length, 0);
});

test('an unchanged online revision survives a reconstructed game object', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room();
  app.click('ai-assist');
  socket.receive({ type: 'state', room: structuredClone(room) });
  assert.equal(app.requests[0].options.signal.aborted, false);
  assert.match(app.element('ai-assist').textContent, /取消/);
  await app.reply(0, { move: redMove });
  assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), [{ type: 'move', ...redMove, revision: room.revision }]);
});

test('a manual online move pending acknowledgement prevents a second submission from assistance', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room();
  app.click('ai-assist');
  app.move(otherRedMove);
  assert.equal(app.game.history.length, 0);
  assert.equal(app.element('ai-assist').disabled, true);
  assert.equal(app.requests[0].options.signal.aborted, true);
  await app.reply(0, { move: redMove });
  assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), [{ type: 'move', ...otherRedMove, revision: room.revision }]);
  const nextGame = rules.applyMove(room.game, otherRedMove.from, otherRedMove.to).game;
  socket.receive({ type: 'state', room: { ...room, revision: room.revision + 1, game: nextGame } });
  assert.equal(app.game.history.length, 1);
  assert.deepEqual(plain(app.game.history[0].to), otherRedMove.to);
});

test('starting then rejecting a vote invalidates old analysis without cancelling a newer retry', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room();
  app.click('ai-assist');
  socket.receive({ type: 'state', room: { ...room, pendingAction: { id: 'vote-1', action: 'draw', side: 'black' } } });
  assert.equal(app.requests[0].options.signal.aborted, true);
  assert.equal(app.element('ai-assist').disabled, true);
  app.click('decline');
  assert.equal(socket.sent.at(-1).type, 'action-answer');
  assert.equal(socket.sent.at(-1).accept, false);
  socket.receive({ type: 'state', room });
  assert.equal(app.element('ai-assist').disabled, false);
  app.click('ai-assist');
  await app.reply(0, { move: redMove });
  assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), []);
  assert.match(app.element('ai-assist').textContent, /取消/);
  assert.equal(app.requests[1].options.signal.aborted, false);
  await app.reply(1, { move: otherRedMove });
  assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), [{ type: 'move', ...otherRedMove, revision: room.revision }]);
});

test('opponent turn, unstarted clocks, pending votes and disconnects disable online assistance', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room({ side: 'black' });
  assert.equal(app.element('ai-assist').disabled, true);
  app.click('ai-assist');
  assert.equal(app.requests.length, 0);
  const ownTurn = { ...room, revision: 30, game: rules.applyMove(room.game, redMove.from, redMove.to).game };
  socket.receive({ type: 'state', room: ownTurn });
  assert.equal(app.element('ai-assist').disabled, false);
  socket.receive({ type: 'state', room: { ...ownTurn, clock: { ...ownTurn.clock, started: false } } });
  assert.equal(app.element('ai-assist').disabled, true);
  socket.receive({ type: 'state', room: { ...ownTurn, pendingAction: { id: 'vote-1', action: 'undo', side: 'red' } } });
  assert.equal(app.element('ai-assist').disabled, true);
  socket.receive({ type: 'state', room: ownTurn });
  app.click('ai-assist');
  socket.close();
  assert.equal(app.element('ai-assist').disabled, true);
  await app.reply(0, { move: blackMove });
  assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), []);
});

test('an engine failure leaves the board intact and the same action can retry successfully', async (t) => {
  const app = await fixture(t);
  app.click('ai-assist');
  await app.reply(0, { error: '引擎正在忙，请稍后重试', code: 'AI_BUSY' }, false);
  assert.equal(app.game.history.length, 0);
  assert.match(app.element('message').textContent, /引擎正在忙/);
  assert.equal(app.element('ai-assist').disabled, false);
  app.click('ai-assist');
  assert.equal(app.requests.length, 2);
  await app.reply(1, { move: redMove });
  assert.equal(app.game.history.length, 1);
});

test('an illegal engine answer never bypasses the shared move rules', async (t) => {
  const app = await fixture(t);
  app.click('ai-assist');
  await app.reply(0, { move: blackMove });
  assert.equal(app.game.history.length, 0);
  assert.equal(app.element('ai-assist').disabled, false);
  assert.ok(app.element('message').textContent);
});

test('preparation and the 3-2-1 countdown block manual play and AI assistance without charging clocks', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room({ started: false });
  const preparing = { ...room, round: 7, phase: 'preparing', ready: { red: false, black: true },
    clock: { ...room.clock, enabled: true, started: false, runningSide: null } };
  socket.receive({ type: 'state', room: preparing });
  assert.equal(app.element('ready-panel').hidden, false);
  assert.match(app.element('own-ready-status').textContent, /未准备/);
  assert.match(app.element('opponent-ready-status').textContent, /已准备/);
  app.move(redMove);
  app.click('ai-assist');
  assert.equal(app.canSelect, false);
  assert.equal(app.requests.length, 0);
  assert.equal(socket.sent.length, 1);
  app.click('ready-button');
  assert.deepEqual(socket.sent.at(-1), { type: 'ready', ready: true, round: 7 });
  const counting = { ...preparing, phase: 'countdown', countdownMs: 3000, ready: { red: true, black: true } };
  socket.receive({ type: 'state', room: counting });
  for (const number of ['3', '2', '1']) {
    assert.equal(app.element('countdown-number').textContent, number);
    assert.equal(app.element('start-countdown').hidden, false);
    assert.equal(app.element('ready-button').disabled, true);
    assert.equal(app.element('ai-assist').disabled, true);
    assert.equal(app.element('time-red').textContent, '10:00');
    app.advance(1000);
  }
  assert.equal(app.canSelect, false, 'Client countdown expiry cannot authorize a move before server start');
  socket.receive({ type: 'state', room: { ...counting, phase: 'playing', clock: { ...counting.clock, started: true, runningSide: 'red' } } });
  assert.equal(app.element('start-countdown').hidden, true);
  assert.equal(app.element('ready-panel').hidden, true);
  assert.equal(app.canSelect, true);
  assert.equal(app.element('ai-assist').disabled, false);
});

test('the restart editor sends nothing until submission and includes color choice and asymmetric times', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room({ side: 'black' });
  app.click('restart');
  assert.equal(app.element('restart-config').open, true);
  assert.equal(socket.sent.length, 1);
  app.element('restart-red-side').value = 'black';
  app.element('restart-red-time-choice').value = '15';
  app.element('restart-black-time-choice').value = 'custom';
  app.element('restart-black-time-custom').value = '0.10';
  app.element('restart-form').dispatch('submit');
  assert.equal(app.element('restart-config').open, false);
  assert.deepEqual(socket.sent.at(-1), { type: 'restart-request', revision: room.revision,
    config: { redSide: 'black', timed: true, timeControl: { red: 900000, black: 6000 } } });
});

test('invalid custom times stay in the editor; untimed submission ignores disabled time inputs', async (t) => {
  const app = await fixture(t);
  const { socket } = await app.room();
  app.click('restart');
  app.element('restart-red-time-choice').value = 'custom';
  app.element('restart-red-time-custom').value = '0.09';
  app.element('restart-form').dispatch('submit');
  assert.equal(app.element('restart-config').open, true);
  assert.equal(socket.sent.length, 1);
  assert.match(app.element('restart-config-error').textContent, /0.1–180/);
  app.element('restart-timed').checked = false;
  app.element('restart-timed').dispatch('change');
  assert.equal(app.element('restart-time-options').hidden, true);
  app.element('restart-form').dispatch('submit');
  assert.equal(socket.sent.at(-1).config.timed, false);
  assert.equal(app.element('restart-config').open, false);
});

test('a configured vote explains the next game from the receiver perspective and returns the exact request ID', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room({ side: 'black' });
  const pendingRestart = { id: 'next-round', action: 'restart', side: 'red', revision: room.revision,
    config: { redSide: 'black', timed: true, timeControl: { red: 900000, black: 740400 } } };
  socket.receive({ type: 'state', room: { ...room, pendingRestart } });
  assert.match(app.element('vote-description').textContent, /你执红先行.*红方 15 分钟.*黑方 12.34 分钟.*准备/);
  assert.equal(app.canSelect, false);
  app.click('decline');
  assert.deepEqual(socket.sent.at(-1), { type: 'restart-answer', requestId: 'next-round', accept: false });
});

test('changing sides for an untimed new round clears old analysis and requires fresh preparation', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room();
  app.click('ai-assist');
  socket.receive({ type: 'seat', side: 'black', code: room.code, token: 'test-seat' });
  socket.receive({ type: 'state', room: { ...room, round: 1, revision: room.revision + 1, phase: 'preparing',
    ready: { red: false, black: false }, clock: { ...room.clock, enabled: false, started: false, runningSide: null } } });
  await app.reply(0, { move: redMove });
  assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), []);
  assert.equal(app.element('clock-panel').hidden, true);
  assert.equal(app.element('time-control-summary').textContent, '本局不计时');
  assert.match(app.element('own-ready-status').textContent, /黑方.*未准备/);
  assert.equal(app.canSelect, false);
});
