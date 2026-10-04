import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as rules from '../../src/shared/rules.js';
import * as sandbox from '../../src/shared/sandbox.js';
import * as analysis from '../../src/shared/analysis.js';
import * as replay from '../../src/shared/replay.js';
import * as ai from '../../web/ai-game.js';
import * as notation from '../../web/move-notation.js';
import * as roomControls from '../../web/room-controls.js';
import * as moveRecords from '../../web/move-records.js';

export const flush = () => new Promise((resolve) => setImmediate(resolve));
export const plain = (value) => JSON.parse(JSON.stringify(value));
const response = (data, ok = true) => ({ ok, json: async () => data });

class Element {
  children = [];
  listeners = new Map();
  attributes = new Map();
  dataset = {};
  style = {};
  className = '';
  value = '';
  hidden = false;
  disabled = false;
  checked = false;
  isConnected = true;
  ownText = '';
  constructor(tag, document, id = '') { this.tagName = tag.toUpperCase(); this.document = document; this.id = id; }
  classList = {
    toggle: (name, enabled) => {
      const names = new Set(this.className.split(' ').filter(Boolean));
      if (enabled ?? !names.has(name)) names.add(name);
      else names.delete(name);
      this.className = [...names].join(' ');
    },
    add: (...names) => { for (const name of names) this.classList.toggle(name, true); },
    remove: (...names) => { for (const name of names) this.classList.toggle(name, false); },
    contains: (name) => this.className.split(' ').includes(name),
  };
  get textContent() { return this.ownText + this.children.map((child) => child.textContent).join(''); }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get parentNode() { return this.parentElement; }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  dispatch(type, event = {}) {
    const dispatched = { target: this, currentTarget: this, preventDefault() {}, ...event };
    for (const callback of this.listeners.get(type) || []) callback(dispatched);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = String(value);
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) {
    for (let child of children) {
      if (typeof child === 'string') { const text = new Element('#text', this.document); text.textContent = child; child = text; }
      child.parentElement = this;
      this.children.push(child);
    }
  }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { this.ownText = ''; this.children = []; this.append(...children); }
  contains(element) { return element === this || this.children.some((child) => child.contains(element)); }
  matches(selector) {
    return selector.split(',').some((part) => {
      const match = part.trim().match(/^([a-z][\w-]*)?(#[\w-]+)?(\.[\w-]+)?(?:\[([\w-]+)(?:=['"]?([^'"\]]+)['"]?)?\])?$/i);
      if (!match) return false;
      const [, tag, id, className, attribute, value] = match;
      return (!tag || this.tagName === tag.toUpperCase()) && (!id || this.id === id.slice(1))
        && (!className || this.classList.contains(className.slice(1)))
        && (!attribute || this.attributes.has(attribute) && (value === undefined || this.getAttribute(attribute) === value));
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (child.matches(selector)) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  getClientRects() {
    for (let node = this; node; node = node.parentElement) if (node.hidden) return [];
    return [this.getBoundingClientRect()];
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 300, height: 200 }; }
  focus() { this.document.activeElement = this; }
  scrollIntoView(options) { (this.scrolls ||= []).push(options); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}

// Parse the real HTML tree so missing controls and hidden-parent interactions fail.
function documentFromHtml(html) {
  const elements = new Map();
  const document = {
    activeElement: null,
    getElementById(id) { assert.ok(elements.has(id), `Application references missing HTML element #${id}`); return elements.get(id); },
    createElement: (tag) => new Element(tag, document),
    createDocumentFragment: () => new Element('fragment', document),
  };
  const root = new Element('root', document);
  const stack = [root];
  const voidTags = new Set(['meta', 'link', 'input', 'img', 'br', 'hr', 'source', 'area', 'base', 'embed', 'param', 'track', 'wbr']);
  for (const match of html.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/gi)) {
    const [, closing, tag, attributes] = match;
    if (closing) {
      while (stack.length > 1) if (stack.pop().tagName === tag.toUpperCase()) break;
      continue;
    }
    const id = attributes.match(/\bid="([^"]+)"/)?.[1] || '';
    const element = new Element(tag, document, id);
    for (const attribute of attributes.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      const [, name, quoted, singleQuoted, bare] = attribute;
      const value = quoted ?? singleQuoted ?? bare ?? '';
      element.setAttribute(name, value);
      if (['hidden', 'disabled', 'checked'].includes(name)) element[name] = true;
      if (name === 'value') element.value = value;
    }
    const immediateText = html.slice(match.index + match[0].length).match(/^[^<]*/)?.[0].trim() || '';
    element.ownText = immediateText;
    stack.at(-1).append(element);
    if (id) elements.set(id, element);
    if (tag === 'html') document.documentElement = element;
    if (tag === 'body') document.body = element;
    if (tag === 'option') {
      const select = element.closest('select');
      if (select && (!select.value || element.attributes.has('selected'))) select.value = element.value;
    }
    if (!voidTags.has(tag.toLowerCase())) stack.push(element);
  }
  document.querySelector = (selector) => root.querySelector(selector);
  document.querySelectorAll = (selector) => root.querySelectorAll(selector);
  return document;
}

export async function appFixture(t) {
  const [source, html] = await Promise.all([
    readFile(new URL('../../web/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../../web/index.html', import.meta.url), 'utf8'),
  ]);
  const executable = source.replace(/^import\s+\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2;/gm,
    (_statement, names, _quote, path) => `const {${names}} = dependencies[${JSON.stringify(path)}];`);
  const document = documentFromHtml(html);
  const requests = [];
  const fetch = async (url, options) => {
    if (url === '/api/server-info') return response({ addresses: [] });
    if (url === '/api/ai/info') return response({ name: 'Pikafish', available: true });
    assert.equal(url, '/api/ai/move');
    return new Promise((resolve) => requests.push({ options, body: JSON.parse(options.body), resolve, settled: false }));
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
  let elapsed = 0;
  let timerId = 0;
  const timers = new Map();
  const schedule = (callback, delay, interval = false) => {
    const milliseconds = Math.max(interval ? 1 : 0, Number(delay) || 0);
    const id = ++timerId;
    timers.set(id, { callback, delay: milliseconds, due: elapsed + milliseconds, interval });
    return id;
  };
  const storage = new Map();
  const windowListeners = new Map();
  let boardView;
  const bridge = {};
  const dependencies = {
    '/shared/rules.js': rules, '/shared/sandbox.js': sandbox, '/shared/analysis.js': analysis,
    '/shared/replay.js': replay, '/move-records.js': moveRecords,
    '/ai-game.js': { ...ai, createAiSearch: (options = {}) => ai.createAiSearch({ ...options, fetchImpl: fetch }) },
    '/move-notation.js': notation, '/room-controls.js': roomControls,
    '/board.js': { renderBoard: (_element, options) => { boardView = options; } },
    '/game-tools.js': { renderCaptured() {} },
  };
  runInNewContext(executable + '\ntestBridge.read = () => ({game, localGame, room, sandbox});', {
    dependencies, testBridge: bridge, document, fetch, WebSocket: Socket, URL, AbortSignal, AbortController, structuredClone,
    performance: { now: () => elapsed },
    window: { addEventListener(type, callback) { const callbacks = windowListeners.get(type) || []; callbacks.push(callback); windowListeners.set(type, callbacks); }, innerWidth: 1200, innerHeight: 900 },
    MutationObserver: class { observe() {} },
    location: { origin: 'http://localhost:3000' },
    sessionStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
    setTimeout: (callback, delay) => schedule(callback, delay), clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, true), clearInterval: (id) => timers.delete(id),
  }, { filename: 'web/app.js' });
  const app = {
    requests, sockets, timers,
    element: (id) => document.getElementById(id),
    get game() { return boardView.game; },
    get realGame() { return bridge.read().game; },
    get roomState() { return bridge.read().room; },
    get sandbox() { return bridge.read().sandbox; },
    get canSelect() { return boardView.canSelect; },
    get now() { return elapsed; },
    click(id, { force = false } = {}) {
      const element = typeof id === 'string' ? document.getElementById(id) : id;
      if (force || (!element.disabled && element.getClientRects().length)) element.dispatch('click');
    },
    input(id, value, type = 'change') { const element = document.getElementById(id); element.value = String(value); element.dispatch(type); },
    key(key) { for (const callback of windowListeners.get('keydown') || []) callback({ key, preventDefault() {} }); },
    move(move) { boardView.onClick(move.from); boardView.onClick(move.to); },
    advance(ms) {
      const target = elapsed + ms;
      let count = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
        if (!next) break;
        assert.ok(++count < 100_000, 'Mock timer queue must settle');
        const [id, timer] = next;
        elapsed = timer.due;
        if (timer.interval) timer.due += timer.delay;
        else timers.delete(id);
        timer.callback();
      }
      elapsed = target;
    },
    async reply(index, data, ok = true) { const request = requests[index]; assert.ok(request); request.settled = true; request.resolve(response(data, ok)); await flush(); },
    async room({ side = 'red', game = rules.createInitialGame(), revision = 29, round = 1, clock = {} } = {}) {
      app.click('create');
      const socket = sockets.at(-1);
      assert.ok(socket, 'Create-room UI must open a socket');
      socket.open();
      socket.receive({ type: 'seat', side, code: 'ABCDEF', token: 'test-seat' });
      const room = { code: 'ABCDEF', revision, round, phase: 'playing', game, players: { red: true, black: true }, pendingAction: null,
        clock: { enabled: true, started: true, runningSide: game.result ? null : game.turn, remainingMs: { red: 600000, black: 600000 },
          initialMs: { red: 600000, black: 600000 }, moveTimeMs: null, moveRemainingMs: null, ...clock } };
      socket.receive({ type: 'state', room });
      await flush();
      return { socket, room };
    },
  };
  t.after(async () => {
    timers.clear();
    for (const request of requests) if (!request.settled) request.resolve(response({ error: 'Test finished' }, false));
    await flush();
  });
  await flush();
  return app;
}
