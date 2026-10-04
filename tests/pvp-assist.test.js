import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as rules from '../src/shared/rules.js';
import * as sandbox from '../src/shared/sandbox.js';
import * as analysis from '../src/shared/analysis.js';
import * as ai from '../web/ai-game.js';
import * as notation from '../web/move-notation.js';
import * as moveRecords from '../web/move-records.js';
import * as replay from '../src/shared/replay.js';
import * as roomControls from '../web/room-controls.js';
import { appFixture } from './helpers/app-fixture.js';

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
  scrollIntoView(options) { (this.scrolls ||= []).push(options); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

async function fixture(t, { serverInfo = { addresses: [] }, rulesOverrides = {} } = {}) {
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
    '/shared/rules.js': { ...rules, ...rulesOverrides },
    '/shared/sandbox.js': sandbox,
    '/shared/analysis.js': analysis,
    '/ai-game.js': { ...ai, createAiSearch: (options = {}) => ai.createAiSearch({ ...options, fetchImpl: fetch }) },
    '/move-notation.js': notation,
    '/move-records.js': moveRecords,
    '/shared/replay.js': replay,
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
    async room({ side = 'red', game = rules.createInitialGame(), revision = 29, started = true, pendingAction = null, clock = {} } = {}) {
      app.click('create');
      const socket = sockets.at(-1);
      assert.ok(socket, 'Create-room UI must open a socket');
      socket.open();
      socket.receive({ type: 'seat', side, code: 'ABCDEF', token: 'test-seat' });
      const room = {
        code: 'ABCDEF', revision, game, players: { red: true, black: true }, pendingAction,
        clock: { enabled: true, started, runningSide: started ? game.turn : null,
          remainingMs: { red: 600000, black: 600000 }, initialMs: { red: 600000, black: 600000 },
          moveTimeMs: null, moveRemainingMs: null, ...clock },
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
  const turnBefore = app.element('turn').textContent;
  const messageBefore = app.element('message').textContent;
  app.click('ai-assist');
  assert.match(app.element('ai-assist').textContent, /取消/);
  assert.equal(app.element('turn').textContent, turnBefore, 'Pending assistance must not add a board-adjacent thinking label');
  assert.equal(app.element('message').textContent, messageBefore, 'The cancel button is enough progress feedback for a direct move');
  assert.equal(app.game.history.length, 0);
  assert.equal(app.canSelect, true);
  assert.deepEqual(app.requests[0].body, { history: [] });
  await app.reply(0, { move: redMove });
  assert.equal(app.game.history.length, 1);
  assert.equal(app.game.turn, 'black');
  assert.deepEqual(plain(app.game.history[0].to), redMove.to);
  assert.equal(app.requests.length, 1, 'Assistance must not become a continuous AI opponent');
  assert.equal(app.canSelect, true);
  assert.match(app.element('ai-assist').textContent, /AI 帮我走一步/);
  assert.match(app.element('ai-assist-message').textContent, /已代走：兵九进一.*轮到对方/);
});

test('suggestion reports a Chinese move in the sidebar without altering the local game', async (t) => {
  const app = await fixture(t);
  const position = plain(app.game);
  const turnBefore = app.element('turn').textContent;
  const messageBefore = app.element('message').textContent;
  app.click('ai-suggest');
  assert.equal(app.element('ai-assist').disabled, false);
  assert.equal(app.element('ai-assist').textContent, 'AI 帮我走一步');
  assert.match(app.element('ai-suggest').textContent, /取消/);
  assert.match(app.element('ai-assist-message').textContent, /构思.*不会自动移动/);
  assert.equal(app.element('turn').textContent, turnBefore);
  assert.equal(app.element('message').textContent, messageBefore);
  await app.reply(0, { move: redMove });
  assert.deepEqual(plain(app.game), position);
  assert.match(app.element('ai-assist-message').textContent, /红方建议：兵九进一/);
  assert.equal(app.element('message').textContent, messageBefore);
  assert.equal(app.element('ai-assist').disabled, false);
  assert.equal(app.element('ai-suggest').textContent, 'AI 帮我构思一步');
});

test('direct move takes over an in-flight suggestion without starting a busy competing search', async (t) => {
  const app = await fixture(t);
  app.click('ai-suggest');
  app.click('ai-assist');
  assert.equal(app.requests.length, 1, 'Mode takeover must reuse the active engine slot');
  assert.equal(app.requests[0].options.signal.aborted, false);
  assert.match(app.element('ai-assist').textContent, /取消/);
  assert.equal(app.element('ai-suggest').textContent, 'AI 帮我构思一步');
  await app.reply(0, { move: redMove });
  assert.equal(app.game.history.length, 1);
  assert.deepEqual(plain(app.game.history[0].to), redMove.to);
  assert.doesNotMatch(app.element('ai-assist-message').textContent, /建议：/);
});

test('a completed suggestion executes its exact move even if a second analysis would choose differently', async (t) => {
  const app = await fixture(t);
  app.click('ai-suggest');
  await app.reply(0, { move: redMove });
  app.click('ai-assist');
  // A regression that reanalyses gets a deliberately different legal answer.
  if (app.requests[1]) await app.reply(1, { move: otherRedMove });
  assert.equal(app.requests.length, 1, 'Executing the displayed suggestion must not reanalyse');
  assert.equal(app.game.history.length, 1);
  assert.deepEqual(plain({ from: app.game.history[0].from, to: app.game.history[0].to }), redMove);
  assert.match(app.element('ai-assist-message').textContent, /AI 已代走：兵九进一.*轮到对方/);
});

test('cached suggestion coordinates are copied and cannot be changed by the response object', async (t) => {
  const app = await fixture(t);
  const returnedMove = plain(redMove);
  app.click('ai-suggest');
  await app.reply(0, { move: returnedMove });
  returnedMove.from.x = otherRedMove.from.x;
  returnedMove.to.x = otherRedMove.to.x;
  app.click('ai-assist');
  assert.equal(app.requests.length, 1);
  assert.deepEqual(plain({ from: app.game.history[0].from, to: app.game.history[0].to }), redMove);
});

test('black suggestions identify the mover and execute the same Arabic-digit notation', async (t) => {
  const app = await fixture(t);
  app.move(redMove);
  app.click('ai-suggest');
  await app.reply(0, { move: blackMove });
  assert.match(app.element('ai-assist-message').textContent, /黑方建议：卒1进1/);
  app.click('flip');
  app.click('ai-assist');
  assert.equal(app.requests.length, 1, 'Flipping the view must preserve the cached move');
  assert.deepEqual(plain(app.game.history.at(-1).to), blackMove.to);
  assert.match(app.element('ai-assist-message').textContent, /AI 已代走：卒1进1/);
});

test('requesting another suggestion replaces the prior cached move', async (t) => {
  const app = await fixture(t);
  app.click('ai-suggest');
  await app.reply(0, { move: redMove });
  app.click('ai-suggest');
  await app.reply(1, { move: otherRedMove });
  assert.match(app.element('ai-assist-message').textContent, /红方建议：兵七进一/);
  app.click('ai-assist');
  assert.equal(app.requests.length, 2);
  assert.deepEqual(plain(app.game.history[0].to), otherRedMove.to);
});

test('cancelling a replacement suggestion cannot revive the prior completed suggestion', async (t) => {
  const app = await fixture(t);
  app.click('ai-suggest');
  await app.reply(0, { move: redMove });
  app.click('ai-suggest');
  app.click('ai-suggest');
  app.click('ai-assist');
  assert.equal(app.requests.length, 3, 'The discarded cached move must not be executed');
  await app.reply(1, { move: redMove });
  assert.equal(app.game.history.length, 0);
  await app.reply(2, { move: otherRedMove });
  assert.deepEqual(plain(app.game.history[0].to), otherRedMove.to);
});

test('a cancelled suggestion reply cannot move pieces or clear a newer direct analysis', async (t) => {
  const app = await fixture(t);
  app.click('ai-suggest');
  app.click('ai-suggest');
  assert.equal(app.requests[0].options.signal.aborted, true);
  app.click('ai-assist');
  await app.reply(0, { move: redMove });
  assert.equal(app.game.history.length, 0);
  assert.match(app.element('ai-assist').textContent, /取消/);
  assert.equal(app.requests[1].options.signal.aborted, false);
  await app.reply(1, { move: otherRedMove });
  assert.equal(app.game.history.length, 1);
  assert.deepEqual(plain(app.game.history[0].to), otherRedMove.to);
});

test('switching a direct analysis to a suggestion removes permission to auto-play', async (t) => {
  const app = await fixture(t);
  app.click('ai-assist');
  app.click('ai-suggest');
  assert.equal(app.requests.length, 1);
  await app.reply(0, { move: redMove });
  assert.equal(app.game.history.length, 0);
  assert.match(app.element('ai-assist-message').textContent, /红方建议：兵九进一/);
});

test('online suggestions leave authoritative state untouched while the clock keeps running', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room();
  const turnBefore = app.element('turn').textContent;
  const messageBefore = app.element('message').textContent;
  app.click('ai-suggest');
  app.advance(1000);
  assert.equal(app.element('time-red').textContent, '09:59');
  assert.equal(app.element('turn').textContent, turnBefore);
  assert.equal(app.element('message').textContent, messageBefore);
  await app.reply(0, { move: redMove });
  assert.equal(app.game.history.length, 0);
  assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), []);
  assert.match(app.element('ai-assist-message').textContent, /红方建议：兵九进一/);
  socket.receive({ type: 'state', room: { ...room, revision: room.revision + 1 } });
  assert.doesNotMatch(app.element('ai-assist-message').textContent, /建议：/);
  assert.match(app.element('ai-assist-message').textContent, /局面已变化/);
});

test('a revised online snapshot cannot produce a suggestion from an old position', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room();
  app.click('ai-suggest');
  socket.receive({ type: 'state', room: { ...room, revision: room.revision + 1 } });
  await app.reply(0, { move: redMove });
  assert.equal(app.game.history.length, 0);
  assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), []);
  assert.doesNotMatch(app.element('ai-assist-message').textContent, /建议：/);
});

test('an online cached suggestion survives clock updates and submits the displayed move once', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room();
  app.click('ai-suggest');
  await app.reply(0, { move: redMove });
  socket.receive({ type: 'clock', code: room.code, revision: room.revision,
    clock: { ...room.clock, remainingMs: { red: 590000, black: 600000 } } });
  socket.receive({ type: 'state', room: structuredClone(room) });
  app.click('flip');
  app.click('ai-assist');
  if (app.requests[1]) await app.reply(1, { move: otherRedMove });
  assert.equal(app.requests.length, 1);
  assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), [{ type: 'move', ...redMove, revision: room.revision }]);
  assert.match(app.element('ai-assist-message').textContent, /AI 已选好：兵九进一.*正在提交/);
  assert.equal(app.game.history.length, 0, 'The cached move still requires authoritative acceptance');
  app.click('ai-assist', { force: true });
  assert.equal(socket.sent.filter(({ type }) => type === 'move').length, 1, 'A pending submission cannot be sent twice');
});

test('a cached online move is revalidated before submission and a rejected move is consumed', async (t) => {
  let validations = 0;
  const app = await fixture(t, { rulesOverrides: {
    validateMove: (...args) => ++validations === 1 ? rules.validateMove(...args) : { ok: false, error: 'Now illegal' },
  } });
  const { socket } = await app.room();
  app.click('ai-suggest');
  await app.reply(0, { move: redMove });
  app.click('ai-assist');
  assert.equal(validations, 2, 'Executing a cached move must call the shared legality validator again');
  assert.equal(app.requests.length, 1);
  assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), []);
  assert.equal(app.game.history.length, 0);
  assert.match(app.element('ai-assist-message').textContent, /不符合本局规则/);
  app.click('ai-assist');
  assert.equal(app.requests.length, 2, 'A rejected cached move must not remain executable');
});

test('local state and mode round trips invalidate completed suggestions even when the board returns unchanged', async (t) => {
  for (const [name, change] of [
    ['restart', async (app) => app.click('restart')],
    ['manual move then undo', async (app) => { app.move(otherRedMove); app.click('undo'); }],
    ['sandbox', async (app) => { app.click('sandbox-toggle'); app.click('sandbox-toggle'); }],
    ['AI opponent', async (app) => { app.element('ai-side').value = 'red'; app.click('ai-start'); app.click('local'); }],
    ['LAN round trip', async (app) => { await app.room(); app.click('local'); }],
  ]) {
    await t.test(name, async (st) => {
      const app = await fixture(st);
      app.click('ai-suggest');
      await app.reply(0, { move: redMove });
      await change(app);
      assert.equal(app.game.history.length, 0);
      app.click('ai-assist');
      assert.equal(app.requests.length, 2, 'An invalidated suggestion must require fresh analysis');
      assert.equal(app.game.history.length, 0);
      await app.reply(1, { move: otherRedMove });
      assert.deepEqual(plain(app.game.history[0].to), otherRedMove.to);
    });
  }
});

test('undo invalidates a completed suggestion for the previous mover', async (t) => {
  const app = await fixture(t);
  app.move(redMove);
  app.click('ai-suggest');
  await app.reply(0, { move: blackMove });
  app.click('undo');
  assert.equal(app.game.turn, 'red');
  assert.doesNotMatch(app.element('ai-assist-message').textContent, /黑方建议/);
  app.click('ai-assist');
  assert.equal(app.requests.length, 2);
  await app.reply(1, { move: otherRedMove });
  assert.equal(app.game.history.length, 1);
  assert.deepEqual(plain(app.game.history[0].to), otherRedMove.to);
});

test('online identity, position, permission and result changes permanently invalidate cached suggestions', async (t) => {
  const state = (socket, room) => socket.receive({ type: 'state', room });
  for (const [name, change] of [
    ['revision', async (_app, socket, room) => state(socket, { ...room, revision: room.revision + 1 })],
    ['round', async (_app, socket, room) => state(socket, { ...room, round: 2 })],
    ['room code', async (_app, socket, room) => state(socket, { ...room, code: 'FEDCBA' })],
    ['seat', async (_app, socket, room) => {
      socket.receive({ type: 'seat', code: room.code, side: 'black', token: 'test-seat' });
      socket.receive({ type: 'seat', code: room.code, side: 'red', token: 'test-seat' });
    }],
    ['turn without revision', async (_app, socket, room) => {
      state(socket, { ...room, game: { ...room.game, turn: 'black' } }); state(socket, room);
    }],
    ['board without revision', async (_app, socket, room) => {
      const changed = structuredClone(room);
      changed.game.board[rules.indexOf(redMove.to)] = { side: 'red', type: 'pawn' };
      state(socket, changed); state(socket, room);
    }],
    ['history without revision', async (_app, socket, room) => {
      state(socket, { ...room, game: { ...room.game, history: [{ ...redMove, piece: { side: 'red', type: 'pawn' } }] } });
      state(socket, room);
    }],
    ['own vote', async (_app, socket, room) => {
      state(socket, { ...room, pendingAction: { id: 'vote', action: 'undo', side: 'red' } }); state(socket, room);
    }],
    ['own restart vote', async (_app, socket, room) => {
      state(socket, { ...room, pendingRestart: { id: 'next-round', action: 'restart', side: 'red' } }); state(socket, room);
    }],
    ['preparing', async (_app, socket, room) => { state(socket, { ...room, phase: 'preparing' }); state(socket, room); }],
    ['timeout result', async (_app, socket, room) => {
      state(socket, { ...room, game: { ...room.game, result: { reason: 'timeout', winner: 'black', loser: 'red' } } });
      state(socket, room);
    }],
    ['new connection', async (app, socket) => { socket.close(); app.click('local'); await app.room(); }],
    ['switch rooms', async (app) => { app.click('local'); await app.room(); }],
  ]) {
    await t.test(name, async (st) => {
      const app = await fixture(st);
      const { socket, room } = await app.room();
      app.click('ai-suggest');
      await app.reply(0, { move: redMove });
      await change(app, socket, room);
      assert.doesNotMatch(app.element('ai-assist-message').textContent, /建议：兵九进一/);
      app.click('ai-assist');
      assert.equal(app.requests.length, 2, 'A restored permission cannot revive an invalidated suggestion');
      assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), []);
      await app.reply(1, { move: otherRedMove });
      assert.deepEqual(app.sockets.at(-1).sent.filter(({ type }) => type === 'move').map(({ from, to }) => ({ from, to })), [otherRedMove]);
    });
  }
});

test('clock expiry invalidates completed suggestions and in-flight takeovers before an authoritative result arrives', async (t) => {
  for (const completed of [true, false]) {
    await t.test(completed ? 'completed' : 'in-flight takeover', async (st) => {
      const app = await fixture(st);
      const { socket, room } = await app.room();
      socket.receive({ type: 'clock', code: room.code, revision: room.revision,
        clock: { ...room.clock, remainingMs: { red: 1000, black: 600000 } } });
      app.click('ai-suggest');
      if (completed) await app.reply(0, { move: redMove });
      else app.click('ai-assist');
      app.advance(1000);
      assert.equal(app.element('ai-assist').disabled, true);
      assert.doesNotMatch(app.element('ai-assist-message').textContent, /建议：/);
      app.click('ai-assist', { force: true });
      if (!completed) await app.reply(0, { move: redMove });
      assert.equal(app.requests.length, 1);
      assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), []);
      socket.receive({ type: 'clock', code: room.code, revision: room.revision, clock: room.clock });
      app.click('ai-assist');
      assert.equal(app.requests.length, 2, 'A later clock correction must not revive the expired suggestion');
      await app.reply(1, { move: otherRedMove });
      assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), [{ type: 'move', ...otherRedMove, revision: room.revision }]);
    });
  }
});

test('notation formats each piece and uses the mover perspective without mutating the position', () => {
  for (const [side, type, from, to, expected] of [
    ['red', 'rook', p(8, 9), p(3, 9), '车一平六'],
    ['black', 'rook', p(0, 8), p(0, 5), '车1退3'],
    ['red', 'cannon', p(7, 7), p(4, 7), '炮二平五'],
    ['black', 'cannon', p(1, 2), p(1, 5), '炮2进3'],
    ['red', 'horse', p(7, 9), p(5, 8), '马二进四'],
    ['black', 'horse', p(7, 0), p(6, 2), '马8进7'],
    ['red', 'elephant', p(2, 9), p(4, 7), '相七进五'],
    ['black', 'elephant', p(6, 0), p(4, 2), '象7进5'],
    ['red', 'advisor', p(3, 9), p(4, 8), '仕六进五'],
    ['black', 'advisor', p(5, 0), p(4, 1), '士6进5'],
    ['red', 'general', p(4, 9), p(4, 8), '帅五进一'],
    ['black', 'general', p(4, 0), p(4, 1), '将5进1'],
    ['red', 'pawn', p(0, 4), p(1, 4), '兵九平八'],
    ['black', 'pawn', p(8, 5), p(8, 6), '卒9进1'],
  ]) {
    const game = { board: Array(90).fill(null) };
    game.board[rules.indexOf(from)] = { side, type };
    const before = plain(game);
    assert.equal(notation.chineseMoveNotation(game, { from, to }), expected);
    assert.deepEqual(game, before);
  }
});

test('notation disambiguates same-file pieces and multiple crowded pawn files', () => {
  const position = (side, type, points) => {
    const board = Array(90).fill(null);
    for (const point of points) board[rules.indexOf(point)] = { side, type };
    return { board };
  };
  const move = (from, to) => ({ from, to });
  const rooks = position('red', 'rook', [p(8, 2), p(8, 7)]);
  assert.equal(notation.chineseMoveNotation(rooks, move(p(8, 2), p(8, 1))), '前车进一');
  assert.equal(notation.chineseMoveNotation(rooks, move(p(8, 7), p(8, 8))), '后车退一');
  rooks.board[rules.indexOf(p(8, 2))].side = 'black';
  assert.equal(notation.chineseMoveNotation(rooks, move(p(8, 7), p(8, 8))), '车一退一');
  const advisors = position('red', 'advisor', [p(4, 7), p(4, 9)]);
  assert.equal(notation.chineseMoveNotation(advisors, move(p(4, 9), p(3, 8))), '仕五进六');
  const triple = position('red', 'pawn', [p(6, 1), p(6, 2), p(6, 3)]);
  assert.equal(notation.chineseMoveNotation(triple, move(p(6, 2), p(5, 2))), '中兵平四');
  const five = position('red', 'pawn', [p(6, 1), p(6, 2), p(6, 3), p(6, 4), p(6, 5)]);
  assert.equal(notation.chineseMoveNotation(five, move(p(6, 5), p(6, 4))), '五兵进一');
  const files = position('red', 'pawn', [p(6, 1), p(6, 2), p(2, 1), p(2, 2), p(4, 3)]);
  assert.equal(notation.chineseMoveNotation(files, move(p(6, 1), p(5, 1))), '一兵平四');
  assert.equal(notation.chineseMoveNotation(files, move(p(2, 1), p(1, 1))), '三兵平八');
  assert.equal(notation.chineseMoveNotation(files, move(p(4, 3), p(4, 2))), '兵五进一');
  const black = position('black', 'pawn', [p(2, 8), p(2, 7), p(6, 8), p(6, 7)]);
  assert.equal(notation.chineseMoveNotation(black, move(p(6, 8), p(5, 8))), '三卒平6');
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
  assert.ok(app.element('ai-suggest').hidden || app.element('ai-suggest').disabled);
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
  assert.equal(app.element('ai-suggest').hidden, true);
  app.click('ai-assist');
  assert.equal(app.requests.length, 1);
  app.click('local');
  await app.reply(0, { move: redMove });
  assert.equal(app.game.history.length, 0);
});

test('AI opponent thinking feedback remains visible while both PvP helper buttons are hidden', async (t) => {
  const app = await fixture(t);
  app.element('ai-side').value = 'black';
  app.click('ai-start');
  assert.equal(app.requests.length, 1);
  assert.equal(app.element('ai-assist').hidden, true);
  assert.equal(app.element('ai-suggest').hidden, true);
  assert.equal(app.element('ai-assist-message').hidden, true);
  assert.match(app.element('turn').textContent, /皮卡鱼思考中/);
  assert.match(app.element('ai-status').textContent, /皮卡鱼正在思考/);
  await app.reply(0, { move: redMove });
  assert.equal(app.game.history.length, 1);
  assert.equal(app.game.turn, 'black');
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
  assert.equal(app.element('ai-suggest').disabled, false);
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

test('an own vote rejected by the opponent invalidates old analysis without cancelling a newer retry', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room();
  app.click('ai-assist');
  socket.receive({ type: 'state', room: { ...room, pendingAction: { id: 'vote-1', action: 'draw', side: 'red' } } });
  assert.equal(app.requests[0].options.signal.aborted, true);
  assert.equal(app.element('ai-assist').disabled, true);
  assert.equal(app.element('vote-wait').hidden, false);
  assert.equal(app.element('vote-buttons').hidden, true);
  // The opponent's rejection arrives as an authoritative state update.
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

test('opponent turn, unstarted clocks, own pending votes and disconnects disable online assistance', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room({ side: 'black' });
  assert.equal(app.element('ai-assist').disabled, true);
  assert.equal(app.element('ai-suggest').disabled, true);
  app.click('ai-assist');
  app.click('ai-suggest', { force: true });
  assert.equal(app.requests.length, 0);
  const ownTurn = { ...room, revision: 30, game: rules.applyMove(room.game, redMove.from, redMove.to).game };
  socket.receive({ type: 'state', room: ownTurn });
  assert.equal(app.element('ai-assist').disabled, false);
  socket.receive({ type: 'state', room: { ...ownTurn, clock: { ...ownTurn.clock, started: false } } });
  assert.equal(app.element('ai-assist').disabled, true);
  assert.equal(app.element('ai-suggest').disabled, true);
  socket.receive({ type: 'state', room: { ...ownTurn, pendingAction: { id: 'vote-1', action: 'undo', side: 'black' } } });
  assert.equal(app.element('ai-assist').disabled, true);
  assert.equal(app.element('ai-suggest').disabled, true);
  socket.receive({ type: 'state', room: ownTurn });
  app.click('ai-assist');
  socket.close();
  assert.equal(app.element('ai-assist').disabled, true);
  assert.equal(app.element('ai-suggest').disabled, true);
  await app.reply(0, { move: blackMove });
  assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), []);
});

const negotiationActions = ['draw', 'undo', 'resign', 'restart'];
function moverPosition(side) {
  let game = rules.applyMove(rules.createInitialGame(), redMove.from, redMove.to).game;
  if (side === 'red') game = rules.applyMove(game, blackMove.from, blackMove.to).game;
  return { game, move: side === 'red' ? otherRedMove : blackMove };
}
function negotiatedRoom(room, action, proposer) {
  const request = { id: `${proposer}-${action}`, action, side: proposer, revision: room.revision };
  if (action === 'restart') request.config = { redSide: 'red', timed: false };
  return { ...room, pendingAction: action === 'restart' ? null : request,
    pendingRestart: action === 'restart' ? request : null };
}

test('opponent proposals preserve a selected piece and allow a legal move while stale vote buttons become inert', async (t) => {
  for (const side of ['red', 'black']) {
    for (const action of negotiationActions) {
      await t.test(`${side} receives ${action}`, async (st) => {
        const app = await appFixture(st);
        const { game, move } = moverPosition(side);
        const { socket, room } = await app.room({ side, game });
        app.clickPoint(move.from);
        assert.deepEqual(plain(app.selected), move.from);
        const proposal = negotiatedRoom(room, action, side === 'red' ? 'black' : 'red');
        socket.receive({ type: 'state', room: proposal });
        assert.equal(app.canSelect, true);
        assert.deepEqual(plain(app.selected), move.from, 'An incoming proposal must preserve the selected piece');
        assert.match(app.element('vote-description').textContent, /可直接合法落子.*自动拒绝/);
        app.advance(1000);
        assert.equal(app.element(`time-${side}`).textContent, '09:59', 'The mover clock continues during negotiation');
        // Click only the destination: reselecting the source would conceal a lost selection.
        app.clickPoint(move.to);
        assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), [{ type: 'move', ...move, revision: room.revision }]);
        assert.deepEqual(plain(app.realGame), game, 'Only the authoritative server can apply the submitted move');
        assert.equal(app.canSelect, false);
        for (const id of ['accept', 'decline']) {
          assert.equal(app.element(id).disabled, true);
          app.click(id, { force: true });
        }
        // An unchanged snapshot while the move is in transit cannot revive the old vote.
        socket.receive({ type: 'state', room: structuredClone(proposal) });
        for (const id of ['accept', 'decline']) app.click(id, { force: true });
        assert.deepEqual(socket.sent.filter(({ type }) => type.endsWith('-answer')), []);
        const next = rules.applyMove(game, move.from, move.to);
        assert.equal(next.ok, true);
        socket.receive({ type: 'state', room: { ...room, revision: room.revision + 1, game: next.game,
          pendingAction: null, pendingRestart: null, clock: { ...room.clock, runningSide: next.game.turn } } });
        assert.equal(app.element('vote-popup').hidden, true);
        for (const id of ['accept', 'decline']) app.click(id, { force: true });
        assert.deepEqual(socket.sent.filter(({ type }) => type.endsWith('-answer')), [], 'Cleared request handlers cannot submit a late answer');
        assert.deepEqual(plain(app.realGame), next.game);
      });
    }
  }
});

test('own proposals lock manual play and prevent both late analysis and cached AI suggestions from submitting moves', async (t) => {
  for (const side of ['red', 'black']) {
    for (const action of negotiationActions) {
      await t.test(`${side} requests ${action}`, async (st) => {
        const app = await appFixture(st);
        const { game, move } = moverPosition(side);
        const { socket, room } = await app.room({ side, game });
        app.clickPoint(move.from);
        app.click('ai-suggest');
        const ownProposal = negotiatedRoom(room, action, side);
        socket.receive({ type: 'state', room: ownProposal });
        assert.equal(app.canSelect, false);
        assert.equal(app.selected, null);
        assert.equal(app.requests[0].options.signal.aborted, true);
        for (const id of ['ai-assist', 'ai-suggest']) {
          assert.equal(app.element(id).disabled, true);
          app.click(id, { force: true });
        }
        app.move(move);
        await app.reply(0, { move });
        assert.equal(app.requests.length, 1, 'Own pending negotiation cannot start a replacement analysis');
        assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), []);
        assert.deepEqual(plain(app.realGame), game);

        socket.receive({ type: 'state', room });
        app.click('ai-suggest');
        await app.reply(1, { move });
        assert.match(app.element('ai-assist-message').textContent, /建议：/);
        socket.receive({ type: 'state', room: ownProposal });
        assert.doesNotMatch(app.element('ai-assist-message').textContent, /建议：/);
        app.click('ai-assist', { force: true });
        assert.equal(app.requests.length, 2);
        assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), [], 'A completed suggestion cannot bypass an own pending request');
      });
    }
  }
});

test('opponent proposals preserve in-flight thinking, takeovers and completed suggestions for both seats', async (t) => {
  for (const side of ['red', 'black']) {
    for (const action of negotiationActions) {
      for (const mode of ['thinking', 'takeover', 'cached']) {
        await t.test(`${side} receives ${action} during ${mode}`, async (st) => {
          const app = await appFixture(st);
          const { game, move } = moverPosition(side);
          const { socket, room } = await app.room({ side, game });
          app.click(mode === 'takeover' ? 'ai-assist' : 'ai-suggest');
          if (mode === 'cached') await app.reply(0, { move });
          socket.receive({ type: 'state', room: negotiatedRoom(room, action, side === 'red' ? 'black' : 'red') });
          assert.equal(app.requests[0].options.signal.aborted, false, 'The opponent cannot cancel a current-position search');
          assert.equal(app.element('ai-assist').disabled, false);
          assert.equal(app.element('ai-suggest').disabled, false);
          if (mode !== 'cached') await app.reply(0, { move });
          if (mode !== 'takeover') {
            assert.match(app.element('ai-assist-message').textContent, /建议：/);
            assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), [], 'Thinking remains advice until explicitly executed');
            app.click('ai-assist');
          }
          assert.equal(app.requests.length, 1, 'The displayed/current analysis must be reused');
          assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), [{ type: 'move', ...move, revision: room.revision }]);
          assert.deepEqual(plain(app.realGame), game);
          app.click('ai-assist', { force: true });
          app.click('accept', { force: true });
          assert.equal(socket.sent.filter(({ type }) => type === 'move').length, 1);
          assert.deepEqual(socket.sent.filter(({ type }) => type.endsWith('-answer')), []);
        });
      }
    }
  }
});

test('an engine failure leaves the board intact and the same action can retry successfully', async (t) => {
  const app = await fixture(t);
  app.click('ai-assist');
  await app.reply(0, { error: '引擎正在忙，请稍后重试', code: 'AI_BUSY' }, false);
  assert.equal(app.game.history.length, 0);
  assert.match(app.element('ai-assist-message').textContent, /引擎正在忙/);
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
  assert.match(app.element('ai-assist-message').textContent, /不符合本局规则/);
});

test('illegal original-position horse jumps are neither displayed as suggestions nor executed', async (t) => {
  for (const mode of ['ai-suggest', 'ai-assist']) {
    for (const to of [p(8, 8), p(7, 8)]) {
      await t.test(`${mode} horse to ${to.x},${to.y}`, async (st) => {
        const app = await fixture(st);
        app.click(mode);
        await app.reply(0, { move: { from: p(1, 9), to } });
        assert.equal(app.game.history.length, 0);
        assert.match(app.element('ai-assist-message').textContent, /不符合本局规则/);
        assert.doesNotMatch(app.element('ai-assist-message').textContent, /建议：/);
        app.click('ai-assist');
        assert.equal(app.requests.length, 2, 'An illegal answer must never be cached for execution');
        assert.equal(app.game.history.length, 0);
      });
    }
  }
});

test('the legal original-position horse suggestion and execution both say 马八进七', async (t) => {
  const app = await fixture(t);
  const horseMove = { from: p(1, 9), to: p(2, 7) };
  app.click('ai-suggest');
  await app.reply(0, { move: horseMove });
  assert.match(app.element('ai-assist-message').textContent, /红方建议：马八进七/);
  app.click('ai-assist');
  if (app.requests[1]) await app.reply(1, { move: redMove });
  assert.equal(app.requests.length, 1);
  assert.deepEqual(plain({ from: app.game.history[0].from, to: app.game.history[0].to }), horseMove);
  assert.match(app.element('ai-assist-message').textContent, /AI 已代走：马八进七/);
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
    config: { redSide: 'black', timed: true, timeControl: { red: 900000, black: 6000 }, moveTimeMs: null } });
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

test('single-move limits parse whole seconds and ignore disabled or untimed inputs', () => {
  let focuses = 0;
  const toggle = { checked: true }, choice = { value: 'custom' }, input = { value: '', focus() { focuses++; } };
  const document = { getElementById: (id) => ({
    'move-timed-toggle': toggle, 'move-time-choice': choice, 'move-time-custom': input,
  })[id] };
  for (const seconds of ['1', '60', '90', '3600', ' 75 ']) {
    input.value = seconds;
    assert.equal(roomControls.readMoveTime(document), Number(seconds) * 1000);
  }
  for (const invalid of ['', '0', '3601', '1.5', '1.0', '-1', '+60', '1e2', 'NaN', 'Infinity', '9007199254740993']) {
    input.value = invalid;
    assert.throws(() => roomControls.readMoveTime(document), /1–3600 秒的整数/);
  }
  assert.equal(focuses, 11);
  toggle.checked = false;
  assert.equal(roomControls.readMoveTime(document), null);
  assert.equal(roomControls.readMoveTime({ getElementById() { throw new Error('Hidden inputs must not be read'); } }, '', false), null);
});

test('create-room controls send disabled, preset and custom move limits without charging a clock locally', async (t) => {
  for (const [name, value, expected] of [['off', null, null], ['60 seconds', '60', 60000], ['90 seconds', '90', 90000], ['custom', '75', 75000]]) {
    await t.test(name, async (st) => {
      const app = await fixture(st);
      if (value != null) {
        app.element('move-timed-toggle').checked = true;
        app.element('move-timed-toggle').dispatch('change');
        app.element('move-time-choice').value = ['60', '90'].includes(value) ? value : 'custom';
        app.element('move-time-choice').dispatch('change');
        app.element('move-time-custom').value = value;
      }
      app.click('create');
      app.sockets.at(-1).open();
      assert.deepEqual(app.sockets.at(-1).sent, [{ type: 'create', timed: true,
        timeControl: { red: 600000, black: 600000 }, moveTimeMs: expected }]);
      assert.equal(app.game.history.length, 0);
    });
  }
});

test('invalid creation limits do not connect and disabling total timing hides and disables all time inputs', async (t) => {
  const app = await fixture(t);
  app.element('move-timed-toggle').checked = true;
  app.element('move-timed-toggle').dispatch('change');
  app.element('move-time-choice').value = 'custom';
  app.element('move-time-choice').dispatch('change');
  app.element('move-time-custom').value = '2.5';
  app.click('create');
  assert.equal(app.sockets.length, 0);
  assert.match(app.element('message').textContent, /1–3600 秒的整数/);
  app.element('red-time-choice').value = 'custom';
  app.element('red-time-choice').dispatch('change');
  app.element('red-time-custom').value = '-1';
  app.element('timed-toggle').checked = false;
  app.element('timed-toggle').dispatch('change');
  assert.equal(app.element('time-options').hidden, true);
  assert.equal(app.element('move-timed-toggle').disabled, true);
  assert.equal(app.element('move-time-custom').disabled, true);
  assert.equal(app.element('red-time-custom').disabled, true, 'Native form validation must ignore an inactive invalid custom field');
  app.click('create');
  app.sockets.at(-1).open();
  assert.deepEqual(app.sockets.at(-1).sent, [{ type: 'create', timed: false, moveTimeMs: null }]);
});

test('restart prepopulates and sends the current single-move limit including custom values', async (t) => {
  for (const seconds of [60, 90, 75]) {
    await t.test(`${seconds} seconds`, async (st) => {
      const app = await fixture(st);
      const { socket, room } = await app.room({ clock: { moveTimeMs: seconds * 1000, moveRemainingMs: 20000 } });
      app.click('restart');
      assert.equal(app.element('restart-move-timed-toggle').checked, true);
      assert.equal(app.element('restart-move-time-choice').value, [60, 90].includes(seconds) ? String(seconds) : 'custom');
      assert.equal(app.element('restart-move-time-custom').value, String(seconds));
      assert.equal(app.element('restart-move-time-options').hidden, false);
      app.element('restart-form').dispatch('submit');
      assert.deepEqual(socket.sent.at(-1), { type: 'restart-request', revision: room.revision,
        config: { redSide: 'red', timed: true, timeControl: { red: 600000, black: 600000 }, moveTimeMs: seconds * 1000 } });
    });
  }
});

test('invalid restart move limits preserve the editor, while turning either timing option off ignores hidden garbage', async (t) => {
  for (const disable of ['restart-move-timed-toggle', 'restart-timed']) {
    await t.test(disable, async (st) => {
      const app = await fixture(st);
      const { socket } = await app.room({ clock: { moveTimeMs: 60000, moveRemainingMs: 50000 } });
      app.click('restart');
      app.element('restart-move-time-choice').value = 'custom';
      app.element('restart-move-time-choice').dispatch('change');
      app.element('restart-move-time-custom').value = '3601';
      app.element('restart-form').dispatch('submit');
      assert.equal(app.element('restart-config').open, true);
      assert.equal(socket.sent.length, 1);
      assert.match(app.element('restart-config-error').textContent, /1–3600 秒的整数/);
      app.element(disable).checked = false;
      app.element(disable).dispatch('change');
      assert.equal(app.element('restart-move-time-options').hidden, true);
      assert.equal(app.element('restart-move-time-custom').disabled, true);
      app.element('restart-form').dispatch('submit');
      assert.equal(app.element('restart-config').open, false);
      assert.equal(socket.sent.at(-1).config.moveTimeMs, null);
      assert.equal(socket.sent.at(-1).config.timed, disable !== 'restart-timed');
    });
  }
});

test('ready snapshots and restart votes state the single-move limit and untimed games omit it', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room({ started: false, clock: { moveTimeMs: 90000, moveRemainingMs: 90000 } });
  socket.receive({ type: 'state', room: { ...room, phase: 'preparing', round: 1, ready: { red: false, black: false } } });
  assert.match(app.element('time-control-summary').textContent, /红方 10 分钟.*黑方 10 分钟.*每步 90 秒/);
  assert.equal(app.element('move-time-red').textContent, '01:30');
  app.advance(5000);
  assert.equal(app.element('move-time-red').textContent, '01:30', 'Preparation must not charge the move clock');
  socket.receive({ type: 'state', room: { ...room, pendingRestart: { id: 'next', action: 'restart', side: 'black',
    config: { redSide: 'red', timed: true, timeControl: { red: 600000, black: 600000 }, moveTimeMs: 75000 } } } });
  assert.match(app.element('vote-description').textContent, /每步 75 秒.*准备/);
  assert.doesNotMatch(roomControls.restartDescription({ redSide: 'red', timed: false, moveTimeMs: 75000 }, 'red'), /每步/);
  assert.match(roomControls.restartDescription({ redSide: 'red', timed: true,
    timeControl: { red: 600000, black: 600000 }, moveTimeMs: null }, 'red'), /单步不限时/);
});

test('move clocks follow the current player, reset from authoritative moves, and keep fixed DOM rows', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room({ clock: { moveTimeMs: 60000, moveRemainingMs: 45000 } });
  assert.equal(app.element('move-time-red').textContent, '00:45');
  assert.equal(app.element('move-time-black').textContent, '—');
  app.advance(1100);
  assert.equal(app.element('move-time-red').textContent, '00:44');
  assert.equal(app.element('time-red').textContent, '09:59');
  const next = rules.applyMove(room.game, redMove.from, redMove.to).game;
  socket.receive({ type: 'state', room: { ...room, game: next, revision: room.revision + 1,
    clock: { ...room.clock, runningSide: 'black', moveRemainingMs: 60000 } } });
  assert.equal(app.element('move-time-red').textContent, '—');
  assert.equal(app.element('move-time-black').textContent, '01:00');
  for (const color of ['red', 'black']) assert.equal(app.element(`move-clock-${color}`).hidden, false);
  socket.receive({ type: 'state', room: { ...room, clock: { ...room.clock, moveTimeMs: null, moveRemainingMs: null } } });
  assert.equal(app.element('move-time-red').textContent, '未启用');
  assert.equal(app.element('move-time-black').textContent, '未启用');
  for (const color of ['red', 'black']) assert.equal(app.element(`move-clock-${color}`).hidden, false, 'Disabling move timing must not remove a reserved row');
});

test('move expiry immediately blocks manual play and AI jobs or cached suggestions while awaiting host adjudication', async (t) => {
  for (const mode of ['manual', 'cached suggestion', 'pending suggestion', 'pending direct']) {
    await t.test(mode, async (st) => {
      const app = await fixture(st);
      const { socket, room } = await app.room({ clock: { moveTimeMs: 1000, moveRemainingMs: 1000 } });
      if (mode !== 'manual') app.click(mode === 'pending direct' ? 'ai-assist' : 'ai-suggest');
      if (mode === 'cached suggestion') await app.reply(0, { move: redMove });
      app.advance(1000);
      assert.equal(app.element('move-time-red').textContent, '00:00');
      assert.equal(app.canSelect, false);
      assert.equal(app.element('ai-assist').disabled, true);
      assert.equal(app.element('ai-suggest').disabled, true);
      assert.equal(app.game.result, null, 'The browser must not decide the loss');
      assert.match(app.element('clock-info').textContent, /本步.*到零.*服务器/);
      app.move(redMove);
      app.click('ai-assist', { force: true });
      if (mode.startsWith('pending')) await app.reply(0, { move: redMove });
      assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), []);
      assert.equal(app.requests.length, mode === 'manual' ? 0 : 1);
      const result = { reason: 'move-timeout', winner: 'black', loser: 'red' };
      socket.receive({ type: 'state', room: { ...room, game: { ...room.game, result }, revision: room.revision + 1,
        clock: { ...room.clock, runningSide: null, moveRemainingMs: 0 } } });
      assert.match(app.element('result-summary').textContent, /黑方获胜.*红方单步超时/);
      assert.equal(app.element('result-overlay').hidden, false);
      assert.equal(app.game.result.reason, 'move-timeout');
    });
  }
});

test('clock corrections cannot revive an expired suggestion and disabled move clocks never restrict play', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room({ clock: { moveTimeMs: 1000, moveRemainingMs: 1000 } });
  app.click('ai-suggest');
  await app.reply(0, { move: redMove });
  app.advance(1000);
  socket.receive({ type: 'clock', code: room.code, revision: room.revision,
    clock: { ...room.clock, moveRemainingMs: 1000 } });
  assert.equal(app.canSelect, true);
  app.click('ai-assist');
  assert.equal(app.requests.length, 2, 'A clock correction permits a new analysis, not execution of a discarded suggestion');
  await app.reply(1, { move: otherRedMove });
  assert.deepEqual(socket.sent.filter(({ type }) => type === 'move'), [{ type: 'move', ...otherRedMove, revision: room.revision }]);
  const untimed = await fixture(t);
  await untimed.room({ clock: { enabled: false, runningSide: null, moveTimeMs: 1000, moveRemainingMs: 0 } });
  untimed.advance(999999);
  assert.equal(untimed.canSelect, true);
  assert.equal(untimed.element('ai-assist').disabled, false);
  assert.equal(untimed.element('move-time-red').textContent, '未启用');
});

test('both clocks freeze at the first deadline and authoritative snapshots cannot make the other budget jump back', async (t) => {
  for (const [name, total, move, expectedTotal, expectedMove, reason] of [
    ['move first', 6000, 1000, '00:05', '00:00', 'move-timeout'],
    ['total first', 1000, 6000, '00:00', '00:05', 'timeout'],
    ['simultaneous', 1000, 1000, '00:00', '00:00', 'timeout'],
  ]) {
    await t.test(name, async (st) => {
      const app = await fixture(st);
      const { socket, room } = await app.room({ clock: { initialMs: { red: total, black: 600000 },
        remainingMs: { red: total, black: 600000 }, moveTimeMs: move, moveRemainingMs: move } });
      app.advance(3500);
      assert.equal(app.element('time-red').textContent, expectedTotal);
      assert.equal(app.element('move-time-red').textContent, expectedMove);
      assert.equal(app.canSelect, false);
      app.advance(9000);
      assert.equal(app.element('time-red').textContent, expectedTotal);
      assert.equal(app.element('move-time-red').textContent, expectedMove);
      const deadline = Math.min(total, move);
      const frozenClock = { ...room.clock, runningSide: null,
        remainingMs: { red: total - deadline, black: 600000 }, moveRemainingMs: move - deadline };
      socket.receive({ type: 'clock', code: room.code, revision: room.revision, clock: frozenClock });
      assert.equal(app.canSelect, false, 'A zero-budget stopped snapshot must not reauthorize play before the result');
      assert.equal(app.element('ai-assist').disabled, true);
      assert.equal(app.element('time-red').textContent, expectedTotal);
      assert.equal(app.element('move-time-red').textContent, expectedMove);
      socket.receive({ type: 'state', room: { ...room, clock: frozenClock, revision: room.revision + 1,
        game: { ...room.game, result: { winner: 'black', loser: 'red', reason } } } });
      assert.equal(app.element('time-red').textContent, expectedTotal);
      assert.equal(app.element('move-time-red').textContent, expectedMove);
    });
  }
});

test('legacy snapshots fall back to the configured move limit and countdown clocks stay frozen', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room({ started: false, clock: { moveTimeMs: 90000, moveRemainingMs: undefined } });
  socket.receive({ type: 'state', room: { ...room, phase: 'countdown', countdownMs: 3000 } });
  app.advance(5000);
  assert.equal(app.element('move-time-red').textContent, '01:30');
  assert.equal(app.element('time-red').textContent, '10:00');
  socket.receive({ type: 'state', room: { ...room, phase: 'playing', clock: { ...room.clock, started: true, runningSide: 'red' } } });
  app.advance(1000);
  assert.equal(app.element('move-time-red').textContent, '01:29');
  assert.equal(app.canSelect, true);
});

test('entering a new preparation stage reveals the sidebar ready controls once per transition', async (t) => {
  const app = await fixture(t);
  const { socket, room } = await app.room({ started: false });
  const preparing = { ...room, round: 1, phase: 'preparing', ready: { red: false, black: false } };
  socket.receive({ type: 'state', room: preparing });
  const panel = app.element('ready-panel');
  assert.deepEqual(plain(panel.scrolls), [{ block: 'nearest', behavior: 'instant' }]);
  app.advance(500);
  socket.receive({ type: 'state', room: { ...preparing, ready: { red: true, black: false } } });
  app.click('flip');
  assert.equal(panel.scrolls.length, 1, 'A ready update, rerender and clock tick must not force sidebar scrolling');
  socket.receive({ type: 'state', room: { ...preparing, phase: 'countdown', countdownMs: 3000 } });
  socket.receive({ type: 'state', room: preparing });
  assert.equal(panel.scrolls.length, 2, 'Returning from a cancelled countdown reveals preparation again');
  socket.receive({ type: 'state', room: { ...preparing, round: 2 } });
  assert.equal(panel.scrolls.length, 3);
  socket.receive({ type: 'state', room: { ...preparing, round: 2, code: 'FEDCBA' } });
  assert.equal(panel.scrolls.length, 4);
});

test('automatic adjudication displays each draw or violation, stops play and permits an agreed undo', async (t) => {
  for (const [reason, winner, loser, description] of [
    ['repetition', null, null, /重复局面.*判和/],
    ['no-capture', null, null, /无吃子自然限着.*判和/],
    ['insufficient-material', null, null, /双方均无进攻子力.*判和/],
    ['perpetual-check', 'black', 'red', /黑方获胜.*红方长将违例/],
    ['perpetual-chase', 'red', 'black', /红方获胜.*黑方长捉违例/],
  ]) {
    await t.test(reason, async (st) => {
      const app = await fixture(st);
      const ended = rules.applyMove(rules.createInitialGame(), redMove.from, redMove.to).game;
      ended.result = { reason, winner, loser };
      const { socket, room } = await app.room({ game: ended, clock: { runningSide: null } });
      assert.equal(app.element('result-title').textContent, winner === null ? '和棋' : `${rules.SIDE_NAMES[winner]}获胜`);
      assert.match(app.element('result-summary').textContent, description);
      assert.equal(app.element('game-result').textContent, app.element('result-summary').textContent);
      assert.equal(app.element('result-overlay').hidden, false);
      assert.equal(app.canSelect, false);
      assert.equal(app.element('ai-assist').disabled, true);
      assert.equal(app.element('draw').disabled, true);
      assert.equal(app.element('resign').disabled, true);
      assert.equal(app.element('undo').disabled, false);
      app.advance(100_000);
      assert.equal(app.element('time-red').textContent, '10:00');
      assert.equal(app.element('time-black').textContent, '10:00');
      app.click('result-dismiss');
      assert.equal(app.element('result-overlay').hidden, true);
      app.click('result-summary');
      assert.equal(app.element('result-overlay').hidden, false);
      app.click('undo');
      assert.deepEqual(socket.sent.at(-1), { type: 'action-request', action: 'undo', revision: room.revision });
      socket.receive({ type: 'state', room: { ...room, revision: room.revision + 1,
        game: rules.undoMove(ended), clock: { ...room.clock, runningSide: 'red' } } });
      assert.equal(app.element('result-overlay').hidden, true);
      assert.equal(app.element('result-summary').hidden, true);
      assert.equal(app.canSelect, true);
    });
  }
});

test('agreement and clock results keep the existing prohibition on undo', async (t) => {
  for (const [reason, winner, loser] of [
    ['draw', null, null], ['resignation', 'black', 'red'],
    ['timeout', 'black', 'red'], ['move-timeout', 'black', 'red'],
  ]) {
    await t.test(reason, async (st) => {
      const app = await fixture(st);
      const game = rules.applyMove(rules.createInitialGame(), redMove.from, redMove.to).game;
      game.result = { reason, winner, loser };
      const { socket } = await app.room({ game, clock: { runningSide: null } });
      assert.equal(app.element('undo').disabled, true);
      app.click('undo');
      assert.equal(socket.sent.filter(({ type }) => type === 'action-request').length, 0);
      if (reason === 'draw') {
        assert.equal(app.element('result-title').textContent, '和棋');
        assert.equal(app.element('result-summary').textContent, '双方同意和棋，对局结束。');
      }
    });
  }
});

test('real move cycles produce the draw popup in local PvP and AI games and undo reopens the board', async (t) => {
  const cycle = [[1, 9, 2, 7], [1, 0, 2, 2], [2, 7, 1, 9], [2, 2, 1, 0]]
    .map(([x, y, tx, ty]) => ({ from: p(x, y), to: p(tx, ty) }));
  for (const aiMode of [false, true]) {
    await t.test(aiMode ? 'human versus AI' : 'local PvP', async (st) => {
      const app = await fixture(st);
      if (aiMode) {
        app.element('ai-side').value = 'red';
        app.click('ai-start');
      }
      for (let ply = 0; ply < 8; ply++) {
        if (!aiMode || ply % 2 === 0) app.move(cycle[ply % 4]);
        else await app.reply(Math.floor(ply / 2), { move: cycle[ply % 4] });
        if (ply < 7) assert.equal(app.game.result, null);
      }
      assert.deepEqual(plain(app.game.result), { winner: null, loser: null, reason: 'repetition' });
      assert.equal(app.element('result-title').textContent, '和棋');
      assert.match(app.element('result-summary').textContent, /重复局面.*判和/);
      assert.equal(app.element('result-overlay').hidden, false);
      assert.equal(app.canSelect, false);
      const previous = plain(app.game);
      app.move(redMove);
      assert.deepEqual(plain(app.game), previous, 'A finished local game must reject additional moves');
      if (aiMode) assert.equal(app.requests.length, 4, 'A finished AI game must not start another engine search');
      app.click('undo');
      assert.equal(app.game.result, null);
      assert.equal(app.game.history.length, aiMode ? 6 : 7);
      assert.equal(app.element('result-overlay').hidden, true);
      assert.equal(app.canSelect, true);
      app.click('restart');
      assert.deepEqual(plain(app.game), plain(rules.createInitialGame()));
      assert.equal(app.element('result-summary').hidden, true);
    });
  }
});
