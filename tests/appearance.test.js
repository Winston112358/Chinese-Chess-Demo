import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createContext, Script } from 'node:vm';
import { boardSkins, pieceSkins } from '../web/appearance-presets.js';
import { pieceTone } from '../web/appearance-colors.js';
import { clericalMetrics } from '../web/fonts/clerical-metrics.js';
import { clericalSquareMetrics } from '../web/fonts/clerical-square-metrics.js';
import { startServer } from '../src/server/server.js';

const storageKey = 'xiangqi-appearance-v1';
const pieceOnlyIds = ['horn-black', 'horn-ivory', 'jade-white', 'jade-celadon', 'jade-green'];
const pieceIds = ['ivory', 'maple', 'beech', 'oak', 'cherry', 'walnut', 'rosewood', ...pieceOnlyIds];
const defaults = { font: 'running', skin: 'ivory', pieceSkin: 'ivory' };
const fontChoices = [
  { id: 'running', family: 'Xiangqi Running' },
  { id: 'kai', family: 'Xiangqi Kai' },
  { id: 'cursive', family: 'Xiangqi Xingkai' },
  { id: 'regular', family: 'Xiangqi Regular' },
  { id: 'clerical', family: 'Xiangqi Clerical' },
  { id: 'clerical-square', family: 'Xiangqi Clerical Square' },
];
const originalFontMetrics = { clerical: clericalMetrics, 'clerical-square': clericalSquareMetrics };
const fontManifest = JSON.parse(await readFile(new URL('../web/fonts/manifest.json', import.meta.url), 'utf8'));
const [html, source, glyphSource, manifestSource] = await Promise.all([
  readFile(new URL('../web/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../web/appearance.js', import.meta.url), 'utf8'),
  readFile(new URL('../web/piece-glyph.js', import.meta.url), 'utf8'),
  readFile(new URL('../web/textures/manifest.json', import.meta.url), 'utf8'),
]);
const textureManifest = JSON.parse(manifestSource);
const sourcePngDirectory = new URL(`../${textureManifest.sourceDirectory || 'assets/source-png'}/`, import.meta.url);
const boardIds = ['ivory', 'celadon', 'mist', 'lotus', 'beech', 'walnut', ...textureManifest.textures.map(({ id }) => id)];
const texturePathsExpected = ['/textures/beech-light.webp', '/textures/walnut-light.webp',
  ...textureManifest.textures.map(({ file }) => `/textures/${file}`),
  ...pieceOnlyIds.map((id) => `/textures/${id}.webp`)].sort();

// These tests execute the real module body in a fresh browser-like context.
// Its static imports are linked to local modules; no browser globals leak.
const linkImports = (moduleSource) => moduleSource.replace(/^import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"];\s*$/gm,
  (_, names, path) => `const {${names}} = __modules[${JSON.stringify(path)}];`);
const browserSource = linkImports(source);

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]));
}

class Element {
  constructor(tagName, attrs = {}) {
    this.tagName = tagName;
    this.attributes = {};
    this.dataset = {};
    this.children = [];
    this.listeners = new Map();
    this.textContent = '';
    this.checked = false;
    this.open = false;
    for (const [name, value] of Object.entries(attrs)) this.setAttribute(name, value);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'value' || name === 'name') this[name] = String(value);
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      this.dataset[key] = String(value);
    }
  }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...nodes) { this.children.push(...nodes); }
  addEventListener(type, listener) {
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }
  dispatch(type) {
    for (const listener of this.listeners.get(type) || []) listener({ target: this });
  }
  get firstElementChild() { return this.children[0]; }
}

function markupElements(className) {
  return [...html.matchAll(/<(?:span|div)\s+[^>]*>/g)]
    .map(([tag]) => attributes(tag))
    .filter((attrs) => attrs.class?.split(/\s+/).includes(className))
    .map((attrs) => new Element('span', attrs));
}

function radioElements(name, markup = html) {
  return [...markup.matchAll(/<input\s+[^>]*>/g)]
    .map(([tag]) => attributes(tag))
    .filter((attrs) => attrs.name === name)
    .map((attrs) => new Element('input', attrs));
}

function markupElementWithId(id) {
  const match = [...html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/g)]
    .find(([, , tagAttributes]) => attributes(tagAttributes).id === id);
  assert.ok(match, `The HTML must include ${id}`);
  const element = new Element(match[1], attributes(match[2]));
  element.open = /(?:^|\s)open(?:\s|=|$)/.test(match[2]);
  return element;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function client({ saved, storage = new Map(), blockedStorage = false } = {}) {
  if (saved !== undefined) storage.set(storageKey, typeof saved === 'string' ? saved : JSON.stringify(saved));
  const board = new Element('div', { 'data-font': 'running', 'data-skin': 'ivory', 'data-piece-skin': 'ivory' });
  const root = new Element('html');
  const fontChoice = new Element('select');
  const status = new Element('p');
  const boardPicker = markupElementWithId('board-skin-picker');
  const piecePicker = markupElementWithId('piece-skin-picker');
  const boardCurrent = markupElementWithId('board-skin-current');
  const pieceCurrent = markupElementWithId('piece-skin-current');
  const boardChoices = radioElements('board-skin');
  const pieceChoices = radioElements('piece-skin');
  const boardPreviews = markupElements('skin-swatch');
  const piecePreviews = markupElements('piece-swatch');
  const boardGlyphs = [];
  const rivers = ['楚', '河', '汉', '界'].map((text, index) => {
    const river = new Element('text', {
      'data-character': text, 'data-letter-size': '48',
      'data-center-x': String([102, 198, 342, 438][index]), 'data-center-y': '300',
      x: String([102, 198, 342, 438][index]), y: '314.4', 'font-size': '48', 'text-anchor': 'middle',
    });
    river.textContent = text;
    return river;
  });
  const findGlyphs = () => {
    const result = [];
    const visit = (element) => {
      if (element.className?.split(/\s+/).includes('piece-glyph')) result.push(element);
      element.children.forEach(visit);
    };
    [board, ...boardPreviews, ...piecePreviews].forEach(visit);
    return result;
  };
  const networkCalls = [];
  const fontLoads = [];
  const writes = [];
  let loadFont = async () => [{ status: 'loaded' }];
  const forbiddenNetwork = (name) => function (...args) {
    networkCalls.push({ name, args });
    throw new Error(`Appearance must not call ${name}`);
  };
  const room = { code: 'LOCAL-TEST', players: { red: 'host', black: 'guest' }, revision: 7 };
  const roomBefore = JSON.stringify(room);
  const document = {
    documentElement: root,
    getElementById: (id) => ({
      board, 'board-font': fontChoice, 'appearance-status': status,
      'board-skin-picker': boardPicker, 'piece-skin-picker': piecePicker,
      'board-skin-current': boardCurrent, 'piece-skin-current': pieceCurrent,
    })[id],
    querySelectorAll: (selector) => selector === '.piece-glyph' ? findGlyphs() : ({
      'input[name="board-skin"]': boardChoices,
      'input[name="piece-skin"]': pieceChoices,
      '.skin-swatch': boardPreviews,
      '.piece-swatch': piecePreviews,
      '.board-river text': rivers,
    })[selector] || [],
    createElement: (name) => new Element(name),
    createElementNS: (_namespace, name) => new Element(name),
    fonts: { load: (...args) => { fontLoads.push(args); return loadFont(...args); } },
  };
  const context = createContext({
    document, console, room,
    socket: { send: forbiddenNetwork('socket.send') },
    fetch: forbiddenNetwork('fetch'), WebSocket: forbiddenNetwork('WebSocket'),
    XMLHttpRequest: forbiddenNetwork('XMLHttpRequest'), EventSource: forbiddenNetwork('EventSource'),
    navigator: { sendBeacon: forbiddenNetwork('sendBeacon') },
    localStorage: {
      getItem(key) {
        if (blockedStorage) throw new Error('Storage unavailable');
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        if (blockedStorage) throw new Error('Storage unavailable');
        writes.push({ key, value });
        storage.set(key, value);
      },
    },
  });
  context.window = context;
  context.__modules = {
    './fonts/clerical-metrics.js': { clericalMetrics },
    './fonts/clerical-square-metrics.js': { clericalSquareMetrics },
  };
  const glyphModule = new Script(`(() => { "use strict";\n${linkImports(glyphSource).replace(/^export\s+/gm, '')}\nreturn { pieceGlyph, chessCharacters, refreshChessGlyphs, setPieceGlyph, setChessText }; })();`, { filename: 'piece-glyph.js' }).runInContext(context);
  for (const [character, side] of [['帅', 'red'], ['车', 'red'], ['将', 'black'], ['车', 'black'], ['砲', 'black'], ['马', 'red'], ['马', 'black']]) {
    const glyph = glyphModule.pieceGlyph(character, side);
    boardGlyphs.push(glyph);
    board.append(glyph);
  }
  context.__modules = {
    '/piece-glyph.js': glyphModule,
    '/appearance-presets.js': { boardSkins, pieceSkins },
    '/appearance-colors.js': { pieceTone },
  };
  new Script(`(() => { "use strict";\n${browserSource}\n})();`, { filename: 'appearance.js' }).runInContext(context);
  await flush();
  return {
    board, root, fontChoice, status, boardChoices, pieceChoices, boardPreviews, piecePreviews,
    boardPicker, piecePicker, boardCurrent, pieceCurrent,
    boardGlyphs, rivers,
    storage, writes, fontLoads, networkCalls,
    saved: () => JSON.parse(storage.get(storageKey)),
    assertLocal() {
      assert.deepEqual(networkCalls, [], 'Appearance must not contact a room, HTTP endpoint or websocket');
      assert.equal(JSON.stringify(room), roomBefore, 'Appearance must not change the room');
      assert.ok(writes.every(({ key }) => key === storageKey), 'Only the local appearance key may be written');
    },
    choose(group, value) {
      const choices = group === 'board' ? boardChoices : pieceChoices;
      const input = choices.find((item) => item.value === value);
      assert.ok(input, `${group} control must offer ${value}`);
      // A native radio selection unchecks the previous radio before dispatching change.
      choices.forEach((item) => { item.checked = item === input; });
      input.dispatch('change');
    },
    chooseFont(value) { fontChoice.value = value; fontChoice.dispatch('change'); },
    fontLoader(loader) { loadFont = loader; },
  };
}

function assertLettering(view, font) {
  const originalMetrics = originalFontMetrics[font];
  const traditional = Boolean(originalMetrics);
  assert.deepEqual(view.boardGlyphs.map((glyph) => glyph.firstElementChild.textContent),
    traditional ? ['帥', '俥', '將', '車', '砲', '傌', '馬'] : ['帅', '车', '将', '车', '砲', '马', '马']);
  assert.deepEqual(view.boardGlyphs.map((glyph) => glyph.getAttribute('data-character')), ['帅', '车', '将', '车', '砲', '马', '马'],
    'Font changes must retain the canonical character for restoration');
  assert.deepEqual(view.rivers.map((river) => river.textContent), traditional ? ['楚', '河', '漢', '界'] : ['楚', '河', '汉', '界']);
  for (const preview of [...view.boardPreviews, ...view.piecePreviews]) {
    assert.deepEqual(preview.children.map((piece) => piece.firstElementChild.firstElementChild.textContent),
      traditional ? ['帥', '將'] : ['帅', '将']);
  }
  const texts = [
    ...view.boardGlyphs.map((glyph) => glyph.firstElementChild), ...view.rivers,
    ...[...view.boardPreviews, ...view.piecePreviews].flatMap((preview) =>
      preview.children.map((piece) => piece.firstElementChild.firstElementChild)),
  ];
  for (const text of texts) {
    const size = Number(text.getAttribute('data-letter-size') ?? 1000);
    const centerX = Number(text.getAttribute('data-center-x') ?? 500);
    const centerY = Number(text.getAttribute('data-center-y') ?? 500);
    assert.equal(text.getAttribute('font-size'), String(size));
    assert.equal(text.getAttribute('x'), String(centerX));
    assert.equal(text.getAttribute('y'), String(centerY + size * .3));
    const metrics = originalMetrics?.glyphs[text.textContent];
    if (metrics) {
      const inkX = centerX + (metrics.renderCenterX - 500) * size / 1000;
      const inkY = centerY + (metrics.renderCenterY - 500) * size / 1000;
      assert.equal(text.getAttribute('transform'),
        `translate(${centerX} ${centerY}) scale(${originalMetrics.commonScale}) translate(${-inkX} ${-inkY})`,
        'The full original font must use its measured center at the piece or river display size');
    } else {
      assert.equal(text.getAttribute('transform'), '', 'Normalized faces and per-character Kai fallbacks must clear the original-font transform');
      if (traditional) {
        const family = fontChoices.find(({ id }) => id === font).family;
        const record = fontManifest.fonts.find((item) => item.family === family);
        assert.ok(record.fallback_characters.includes(text.textContent),
          `Only the known missing glyphs may use fallback geometry: ${font} ${text.textContent}`);
      }
    }
  }
}

test('all six fonts have local faces, selection options and complete bundled fallback coverage', async () => {
  const select = html.match(/<select\b[^>]*id="board-font"[^>]*>([\s\S]*?)<\/select>/)?.[1];
  assert.ok(select);
  assert.deepEqual([...select.matchAll(/<option\b[^>]*value="([^"]+)"/g)].map(([, id]) => id), fontChoices.map(({ id }) => id));
  const css = await readFile(new URL('../web/style.css', import.meta.url), 'utf8');
  assert.equal(fontManifest.fonts.length, fontChoices.length);
  const fallback = fontManifest.fonts.find(({ family }) => family === 'Xiangqi Kai');
  for (const { id, family } of fontChoices) {
    const record = fontManifest.fonts.find((item) => item.family === family);
    assert.ok(record, family);
    assert.match(css, new RegExp(`font-family: "${family}"; src: url\\('/fonts/${record.file}'\\)`));
    const selector = css.match(new RegExp(`:root\\[data-font="${id}"\\][^{]+\\{([^}]+)\\}`))?.[1];
    assert.ok(selector?.includes(`"${family}"`), `${id} must use its own bundled primary face`);
    assert.ok(selector?.includes('"Xiangqi Kai"'), `${id} must use the bundled fallback`);
    assert.ok([...record.fallback_characters].every((character) => fallback.characters.includes(character)));
    assert.ok([...(record.required_characters || fontManifest.simplified_characters)].every((character) =>
      record.characters.includes(character) || fallback.characters.includes(character)), `${id} must cover every displayed character`);
  }
  for (const { id, family } of fontChoices.filter(({ id }) => originalFontMetrics[id])) {
    const record = fontManifest.fonts.find((item) => item.family === family);
    const metrics = originalFontMetrics[id];
    assert.equal(record.unmodified_original, true, 'Clerical lettering must come from its unchanged original font');
    assert.ok([...record.required_characters].every((character) =>
      metrics.glyphs[character] || record.fallback_characters.includes(character)));
    assert.ok([...'傌馬俥車'].every((character) => record.required_characters.includes(character)));
    assert.equal(metrics.sourceSha256, record.source_sha256);
    assert.equal(record.sha256, record.source_sha256, 'The distributed original TTF must retain its source hash');
  }
  const square = fontManifest.fonts.find(({ family }) => family === 'Xiangqi Clerical Square');
  const aoyagi = fontManifest.fonts.find(({ family }) => family === 'Xiangqi Clerical');
  assert.equal(aoyagi.fallback_characters, '傌');
  assert.equal(Object.keys(clericalMetrics.glyphs).length, 17);
  assert.ok(!clericalMetrics.glyphs['傌']);
  assert.ok(!aoyagi.characters.includes('傌'));
  assert.equal(square.file, 'xiangqi-clerical-square.ttf');
  assert.deepEqual([...square.fallback_characters].sort(), ['傌', '俥', '砲'].sort());
  assert.equal(Object.keys(clericalSquareMetrics.glyphs).length, 15);
  assert.deepEqual(Object.keys(clericalSquareMetrics.glyphs).sort(), [...'帥仕相馬車炮兵將士象卒楚河漢界'].sort());
  for (const character of ['傌', '俥', '砲']) {
    assert.ok(!clericalSquareMetrics.glyphs[character]);
    assert.ok(!square.characters.includes(character));
    assert.ok(fallback.characters.includes(character));
  }
  assert.equal([...fallback.characters.trim()].length, 23);
  assert.equal(fallback.preserved_characters, '帅仕相马车炮兵将士象砲卒楚河汉界帥馬俥車將漢');
  assert.equal(fallback.preserved_glyphs_sha256, 'e9a041b097397d86d2f88ca06d0965129fb7ebacd546a4357df879597fed8ee6');
});

test('all six saved font choices restore and switching fonts refreshes pieces, both cars, both horses and river labels locally', async () => {
  for (const { id, family } of fontChoices) {
    const view = await client({ saved: { font: id, skin: 'hainan-huali', pieceSkin: 'horn-black' } });
    assert.equal(view.board.dataset.font, id);
    assert.equal(view.root.dataset.font, id);
    assert.equal(view.fontChoice.value, id);
    assert.deepEqual(view.saved(), { font: id, skin: 'hainan-huali', pieceSkin: 'horn-black' });
    assertLettering(view, id);
    assert.deepEqual(view.fontLoads.map(([face]) => face).sort(), [...new Set(['Xiangqi Kai', family])].map((name) => `38px "${name}"`).sort());
    if (originalFontMetrics[id]) {
      assert.ok(view.fontLoads.every(([, characters]) => [...'帥傌馬俥車將漢炮砲'].every((character) => characters.includes(character))),
        'Both colors of the traditional cars and horses and all fallback glyphs must be requested before the switch');
    }
    view.chooseFont(originalFontMetrics[id] ? 'regular' : 'clerical-square');
    await flush();
    assertLettering(view, originalFontMetrics[id] ? 'regular' : 'clerical-square');
    view.chooseFont(id);
    await flush();
    assertLettering(view, id);
    assertPieceState(view, 'horn-black');
    view.assertLocal();
  }
});

test('switching between both original clerical fonts applies the matching metrics and latest async choice', async () => {
  const view = await client({ saved: { font: 'clerical', skin: 'hainan-huali', pieceSkin: 'ivory' } });
  view.chooseFont('clerical-square');
  await flush();
  assertLettering(view, 'clerical-square');
  assert.equal(view.boardGlyphs[1].firstElementChild.getAttribute('transform'), '', 'Red 俥 uses normalized Kai fallback');
  assert.equal(view.boardGlyphs[4].firstElementChild.getAttribute('transform'), '', 'Black 砲 uses normalized Kai fallback');
  assert.equal(view.boardGlyphs[5].firstElementChild.getAttribute('transform'), '', 'Red 傌 uses normalized Kai fallback in either original font');
  assert.match(view.boardGlyphs[6].firstElementChild.getAttribute('transform'), /^translate/, 'Black 馬 retains native original-font geometry');
  const pending = [];
  view.fontLoader((font) => new Promise((resolve) => pending.push({ font, resolve })));
  view.chooseFont('clerical');
  view.chooseFont('clerical-square');
  assert.equal(pending.length, 4);
  pending.slice(2).forEach(({ resolve }) => resolve([{ status: 'loaded' }]));
  await flush();
  pending.slice(0, 2).forEach(({ resolve }) => resolve([{ status: 'loaded' }]));
  await flush();
  assert.equal(view.root.dataset.font, 'clerical-square');
  assert.equal(view.board.dataset.font, 'clerical-square');
  assertLettering(view, 'clerical-square');
  assert.deepEqual(view.saved(), { font: 'clerical-square', skin: 'hainan-huali', pieceSkin: 'ivory' });
  const reloaded = await client({ storage: view.storage });
  assertLettering(reloaded, 'clerical-square');
  for (const clientView of [view, reloaded]) clientView.assertLocal();
});

function assertPieceState(view, expected) {
  assert.equal(view.board.dataset.pieceSkin, expected);
  assert.equal(view.root.dataset.pieceSkin, expected);
  assert.ok(view.boardPreviews.every((preview) => preview.dataset.pieceSkin === expected));
  assert.equal(view.board.dataset.pieceTone, pieceTone(view.board.dataset.skin, expected));
  assert.equal(view.root.dataset.pieceTone, view.board.dataset.pieceTone);
  assert.ok(view.boardPreviews.every((preview) => preview.dataset.pieceTone === pieceTone(preview.dataset.skin, expected)),
    'Each board preview must derive its surface tone from its own board, not the currently selected board');
  assert.ok(view.piecePreviews.every((preview) => preview.dataset.pieceTone === 'light'));
  assert.deepEqual(view.piecePreviews.map((preview) => preview.dataset.pieceSkin), pieceIds,
    'Material options must retain their own preview rather than inherit the selected material');
  assert.deepEqual(view.pieceChoices.filter((input) => input.checked).map((input) => input.value), [expected]);
  assert.equal(view.boardCurrent.textContent, boardSkins.find(({ id }) => id === view.board.dataset.skin).label,
    'The board summary must show its selected material name');
  assert.equal(view.pieceCurrent.textContent, pieceSkins.find(({ id }) => id === expected).label,
    'The piece summary must show its selected material name');
}

test('board and piece choices use separate native details that start collapsed', async () => {
  const appearancePanel = html.match(/<section\b[^>]*class="[^"]*\bappearance-panel\b[^"]*"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  assert.ok(appearancePanel, 'The appearance panel must exist');
  const pickers = [...appearancePanel.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)];
  assert.equal(pickers.length, 2);
  assert.equal([...appearancePanel.matchAll(/<details\b/g)].length, 2, 'The two pickers must be sibling containers');
  for (const [index, prefix, group, presets] of [
    [0, 'board-skin', 'board-skin', boardSkins],
    [1, 'piece-skin', 'piece-skin', pieceSkins],
  ]) {
    const [, tagAttributes, body] = pickers[index];
    const attrs = attributes(tagAttributes);
    assert.equal(attrs.id, `${prefix}-picker`);
    assert.ok(attrs.class.split(/\s+/).includes('appearance-picker'));
    assert.doesNotMatch(tagAttributes, /(?:^|\s)open(?:\s|=|$)/, 'Each picker starts collapsed');
    assert.doesNotMatch(tagAttributes, /(?:^|\s)name(?:\s|=|$)/, 'Opening one picker must not close the other');
    assert.doesNotMatch(body, /<details\b/, 'The piece picker must not be nested inside the board picker');
    assert.match(body, /^\s*<summary\b/, 'Native disclosure needs its summary before the choices');
    const [, summaryAttributes, summaryBody] = body.match(/<summary\b([^>]*)>([\s\S]*?)<\/summary>/) || [];
    assert.equal(attributes(summaryAttributes || '').id, `${prefix}-summary`);
    assert.match(summaryBody || '', new RegExp(`\\bid="${prefix}-current"`));
    assert.deepEqual(radioElements(group, body).map(({ value }) => value), presets.map(({ id }) => id));
    assert.equal(radioElements(index === 0 ? 'piece-skin' : 'board-skin', body).length, 0);
  }
  const view = await client();
  assert.equal(view.boardPicker.open, false);
  assert.equal(view.piecePicker.open, false);
  assertPieceState(view, 'ivory');
  view.assertLocal();
});

test('collapsed summaries restore saved choices and changing either material preserves disclosure states', async () => {
  const view = await client({ saved: { font: 'kai', skin: 'hainan-huali', pieceSkin: 'jade-green' } });
  assert.equal(view.boardPicker.open, false);
  assert.equal(view.piecePicker.open, false);
  assertPieceState(view, 'jade-green');
  view.boardPicker.open = true;
  view.choose('board', 'zitan');
  assert.equal(view.boardPicker.open, true);
  assert.equal(view.piecePicker.open, false);
  assertPieceState(view, 'jade-green');
  view.piecePicker.open = true;
  view.choose('piece', 'horn-black');
  assert.equal(view.boardPicker.open, true);
  assert.equal(view.piecePicker.open, true);
  assert.equal(view.board.dataset.skin, 'zitan');
  assertPieceState(view, 'horn-black');
  view.boardPicker.open = false;
  view.choose('piece', 'jade-white');
  assert.equal(view.boardPicker.open, false);
  assert.equal(view.piecePicker.open, true);
  assertPieceState(view, 'jade-white');
  assert.deepEqual(view.saved(), { font: 'kai', skin: 'zitan', pieceSkin: 'jade-white' });
  view.assertLocal();
});

test('every board and piece preset has matching controls, previews and CSS', async () => {
  assert.deepEqual(boardSkins.map(({ id }) => id), boardIds);
  assert.deepEqual(pieceSkins.map(({ id }) => id), pieceIds);
  assert.ok(pieceOnlyIds.every((id) => !boardIds.includes(id)), 'Horn and jade are piece materials, not wood boards');
  const css = await readFile(new URL('../web/appearance.css', import.meta.url), 'utf8');
  for (const [presets, radioName, previewClass, attribute] of [
    [boardSkins, 'board-skin', 'skin-swatch', 'data-skin'],
    [pieceSkins, 'piece-skin', 'piece-swatch', 'data-piece-skin'],
  ]) {
    const ids = presets.map(({ id }) => id);
    assert.equal(new Set(ids).size, ids.length, 'Preset IDs must be unique');
    assert.ok(presets.every(({ label, detail }) => label.trim() && detail.trim()));
    assert.deepEqual(radioElements(radioName).map(({ value }) => value), ids);
    assert.deepEqual(markupElements(previewClass).map((element) => element.attributes[attribute]), ids);
    for (const id of ids) assert.match(css, new RegExp(`\\[${attribute}=["']${id}["']\\]`), `CSS must style ${attribute}=${id}`);
  }
});

test('the wood manifest connects every wood source to a selectable board and verified WebP', async () => {
  const runtimeDirectory = new URL('../web/textures/', import.meta.url);
  const pngs = (await readdir(sourcePngDirectory)).filter((name) => name.toLowerCase().endsWith('.png'));
  const entries = textureManifest.textures;
  assert.equal(new Set(entries.map(({ source }) => source)).size, entries.length);
  assert.ok(entries.every(({ source }) => pngs.includes(source)), 'Every board wood source must exist in the separate source directory');
  assert.equal(new Set(entries.map(({ id }) => id)).size, entries.length);
  for (const entry of entries) {
    assert.equal(entry.file, `${entry.id}.webp`);
    assert.ok(boardSkins.some(({ id }) => id === entry.id), `${entry.source} must be a selectable board`);
    const [sourceImage, runtimeImage] = await Promise.all([
      readFile(new URL(entry.source, sourcePngDirectory)), readFile(new URL(entry.file, runtimeDirectory)),
    ]);
    assert.equal(createHash('sha256').update(sourceImage).digest('hex'), entry.sourceSha256, entry.source);
    assert.equal(createHash('sha256').update(runtimeImage).digest('hex'), entry.sha256, entry.file);
    assert.equal(runtimeImage.toString('ascii', 0, 4), 'RIFF', entry.file);
    assert.equal(runtimeImage.toString('ascii', 8, 12), 'WEBP', entry.file);
  }
});

test('the separate source directory has an origin record for every runtime texture and PNG', async () => {
  const pngs = (await readdir(sourcePngDirectory)).filter((name) => name.toLowerCase().endsWith('.png')).sort();
  const origins = textureManifest.allImageOrigins;
  assert.ok(Array.isArray(origins), 'The texture manifest must identify all image origins, including horn and jade');
  assert.deepEqual(origins.map(({ source }) => source).sort(), pngs, 'Every original PNG must map exactly once');
  assert.deepEqual(origins.map(({ file }) => `/textures/${file}`).sort(), texturePathsExpected);
  const runtimePngs = (await readdir(new URL('../web/textures/', import.meta.url))).filter((name) => name.toLowerCase().endsWith('.png'));
  assert.deepEqual(runtimePngs, [], 'Original PNGs belong in their separate source folder, not runtime textures');
  for (const origin of origins) {
    const [original, runtime] = await Promise.all([
      readFile(new URL(origin.source, sourcePngDirectory)),
      readFile(new URL(`../web/textures/${origin.file}`, import.meta.url)),
    ]);
    assert.equal(original.toString('hex', 0, 8), '89504e470d0a1a0a', origin.source);
    assert.equal(createHash('sha256').update(original).digest('hex'), origin.sourceSha256, origin.source);
    assert.equal(createHash('sha256').update(runtime).digest('hex'), origin.sha256, origin.file);
  }
});

test('the preview base rule preserves the selected piece material texture', async () => {
  const css = (await readFile(new URL('../web/appearance.css', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  let backgroundImage = 'none';
  // The shared material rule and base geometry rule use this exact same selector
  // and specificity. Model their declaration order to catch a later shorthand reset.
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(',').some((selector) => selector.trim() === '.appearance-panel .swatch-piece')) continue;
    for (const declaration of body.split(';')) {
      const separator = declaration.indexOf(':');
      const property = declaration.slice(0, separator).trim();
      const value = declaration.slice(separator + 1).trim();
      if (property === 'background-image') backgroundImage = value;
      else if (property === 'background') backgroundImage = 'none';
    }
  }
  assert.match(backgroundImage, /var\(--piece-texture\)/, 'Base preview styling must not clear the material with background shorthand');
});

test('old preferences retain the font/board choice and default to ivory pieces', async () => {
  for (const skin of boardIds.slice(0, 6)) {
    const view = await client({ saved: { font: 'kai', skin } });
    assert.equal(view.board.dataset.skin, skin);
    assert.equal(view.board.dataset.font, 'kai');
    assert.equal(view.root.dataset.font, 'kai');
    assertPieceState(view, 'ivory');
    assert.deepEqual(view.saved(), { font: 'kai', skin, pieceSkin: 'ivory' });
    view.assertLocal();
  }
});

test('unknown and malformed saved fields fall back independently without changing valid choices', async () => {
  for (const [saved, expected] of [
    [{ font: 'unknown', skin: 'unknown', pieceSkin: 'unknown' }, defaults],
    [{ font: '__proto__', skin: '../private', pieceSkin: 'ash' }, defaults],
    [{ font: 'cursive', skin: 'maple', pieceSkin: 'golden-oak' }, { font: 'cursive', skin: 'maple', pieceSkin: 'ivory' }],
    [{ font: 'kai', skin: 'unknown', pieceSkin: 'oak' }, { font: 'kai', skin: 'ivory', pieceSkin: 'oak' }],
    ['{broken JSON', defaults],
    ['null', defaults],
    ['42', defaults],
  ]) {
    const view = await client({ saved });
    assert.equal(view.board.dataset.skin, expected.skin);
    assert.equal(view.board.dataset.font, expected.font);
    assertPieceState(view, expected.pieceSkin);
    assert.deepEqual(view.saved(), expected);
    view.assertLocal();
  }
});

test('all board/piece combinations select independently and keep option previews accurate', async () => {
  const view = await client();
  for (const skin of boardIds) {
    for (const pieceSkin of pieceIds) {
      const previousPieces = view.board.dataset.pieceSkin;
      view.choose('board', skin);
      assert.equal(view.board.dataset.skin, skin);
      assertPieceState(view, previousPieces);
      view.choose('piece', pieceSkin);
      assert.equal(view.board.dataset.skin, skin, 'Changing pieces must preserve the board');
      assertPieceState(view, pieceSkin);
      assert.deepEqual(view.boardChoices.filter((input) => input.checked).map((input) => input.value), [skin]);
      assert.deepEqual(view.saved(), { font: 'running', skin, pieceSkin });
    }
  }
  assert.deepEqual(view.boardPreviews.map((preview) => preview.dataset.skin), boardIds);
  for (const preview of [...view.boardPreviews, ...view.piecePreviews]) {
    assert.deepEqual(preview.children.map((piece) => piece.className), ['swatch-piece red', 'swatch-piece black']);
    assert.deepEqual(preview.children.map((piece) => piece.firstElementChild.firstElementChild.textContent), ['帅', '将']);
    for (const piece of preview.children) {
      const svg = piece.firstElementChild;
      assert.equal(svg.attributes.viewBox, '0 0 1000 1000');
      assert.equal(svg.firstElementChild.attributes.x, '500');
      assert.equal(svg.firstElementChild.attributes.y, '800');
    }
  }
  view.assertLocal();
});

test('preferences persist on reload while host and guest browser contexts remain independent', async () => {
  const host = await client();
  const guest = await client({ saved: { font: 'kai', skin: 'ash', pieceSkin: 'horn-black' } });
  host.choose('board', 'golden-nanmu');
  host.choose('piece', 'jade-green');
  host.chooseFont('cursive');
  await flush();
  assert.deepEqual(host.saved(), { font: 'cursive', skin: 'golden-nanmu', pieceSkin: 'jade-green' });
  assert.deepEqual(guest.saved(), { font: 'kai', skin: 'ash', pieceSkin: 'horn-black' });
  assertPieceState(guest, 'horn-black');
  assert.equal(guest.board.dataset.skin, 'ash');
  const reloaded = await client({ storage: host.storage });
  assert.deepEqual(reloaded.saved(), host.saved());
  assert.equal(reloaded.board.dataset.font, 'cursive');
  assert.equal(reloaded.root.dataset.font, 'cursive');
  assert.equal(reloaded.board.dataset.skin, 'golden-nanmu');
  assertPieceState(reloaded, 'jade-green');
  for (const view of [host, guest, reloaded]) view.assertLocal();
});

test('delayed font loads cannot undo a newer font or concurrent material selections', async () => {
  const view = await client();
  const pending = [];
  view.fontLoader((font) => new Promise((resolve) => pending.push({ font, resolve })));
  view.chooseFont('regular');
  view.chooseFont('clerical');
  view.choose('board', 'cherry');
  view.choose('piece', 'walnut');
  assert.equal(pending.length, 4, 'Each requested font loads its bundled fallback and primary face');
  pending.slice(2).forEach(({ resolve }) => resolve([{ status: 'loaded' }]));
  await flush();
  pending.slice(0, 2).forEach(({ resolve }) => resolve([{ status: 'loaded' }]));
  await flush();
  assert.equal(view.board.dataset.font, 'clerical');
  assert.equal(view.root.dataset.font, 'clerical');
  assertLettering(view, 'clerical');
  assertPieceState(view, 'walnut');
  assert.deepEqual(view.saved(), { font: 'clerical', skin: 'cherry', pieceSkin: 'walnut' });
  assert.ok(view.fontLoads.every(([, characters]) => characters.includes('砲')), 'Fallback loading must cover the black cannon');
  view.assertLocal();
});

test('a font resource failure preserves the last font and independently selected materials', async () => {
  const view = await client();
  view.choose('board', 'teak');
  view.choose('piece', 'oak');
  view.fontLoader(async () => []);
  view.chooseFont('cursive');
  await flush();
  assert.equal(view.board.dataset.font, 'running');
  assert.equal(view.root.dataset.font, 'running');
  assert.equal(view.fontChoice.value, 'running');
  assert.equal(view.board.dataset.skin, 'teak');
  assertPieceState(view, 'oak');
  assert.deepEqual(view.saved(), { font: 'running', skin: 'teak', pieceSkin: 'oak' });
  assert.match(view.status.textContent, /载入失败/);
  view.assertLocal();
});

test('unavailable local storage still allows local board, material and font changes', async () => {
  const view = await client({ blockedStorage: true });
  view.choose('board', 'rosewood');
  view.choose('piece', 'maple');
  view.chooseFont('kai');
  await flush();
  assert.equal(view.board.dataset.skin, 'rosewood');
  assert.equal(view.board.dataset.font, 'kai');
  assertPieceState(view, 'maple');
  assert.match(view.status.textContent, /无法保存偏好/);
  assert.equal(view.writes.length, 0);
  view.assertLocal();
});

test('HTTP serves all CSS textures byte-for-byte with GET/HEAD and keeps raw assets private', { timeout: 10000 }, async () => {
  const css = await readFile(new URL('../web/appearance.css', import.meta.url), 'utf8');
  const texturePaths = [...new Set([...css.matchAll(/url\(\s*['"]?(\/textures\/[^)'"\s]+)['"]?\s*\)/g)].map(([, path]) => path))].sort();
  assert.deepEqual(texturePaths, texturePathsExpected, 'CSS must use every bundled wood and only known runtime assets');
  let engineClosed = false;
  let engineCalls = 0;
  const server = await startServer({ port: 0, host: '127.0.0.1', aiEngine: {
    getInfo: async () => { engineCalls += 1; return { available: false }; },
    bestMove: async () => { engineCalls += 1; throw new Error('Texture requests must not search'); },
    close: async () => { engineClosed = true; },
  } });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    for (const path of texturePaths) {
      const expected = await readFile(new URL(`../web${path}`, import.meta.url));
      assert.equal(expected.toString('ascii', 0, 4), 'RIFF', path);
      assert.equal(expected.toString('ascii', 8, 12), 'WEBP', path);
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('content-type'), 'image/webp', path);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, path);
      const head = await fetch(base + path, { method: 'HEAD' });
      assert.equal(head.status, 200, path);
      assert.equal(head.headers.get('content-type'), 'image/webp', path);
      assert.equal((await head.arrayBuffer()).byteLength, 0, path);
    }
    for (const path of ['/appearance-presets.js', '/appearance-colors.js', '/fonts/clerical-metrics.js', '/fonts/clerical-square-metrics.js']) {
      const module = await fetch(base + path);
      assert.equal(module.status, 200, path);
      assert.match(module.headers.get('content-type'), /^text\/javascript/, path);
      assert.equal(await module.text(), await readFile(new URL(`../web${path}`, import.meta.url), 'utf8'), path);
    }
    for (const { render_metrics: file, render_metrics_sha256: hash } of fontManifest.fonts.filter((font) => font.render_metrics)) {
      const path = `/fonts/${file}`;
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type'), /^application\/json/, path);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, path);
      assert.deepEqual(bytes, await readFile(new URL(`../web${path}`, import.meta.url)), path);
      const head = await fetch(base + path, { method: 'HEAD' });
      assert.equal(head.status, 200, path);
      assert.match(head.headers.get('content-type'), /^application\/json/, path);
      assert.equal((await head.arrayBuffer()).byteLength, 0, path);
    }
    for (const { file, sha256 } of fontManifest.fonts) {
      const path = `/fonts/${file}`;
      const contentType = file.endsWith('.ttf') ? 'font/ttf' : 'font/woff2';
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('content-type'), contentType, path);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.toString('hex', 0, 4), file.endsWith('.ttf') ? '00010000' : '774f4632', path);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, path);
      assert.deepEqual(bytes, await readFile(new URL(`../web/fonts/${file}`, import.meta.url)), path);
      const head = await fetch(base + path, { method: 'HEAD' });
      assert.equal(head.status, 200, path);
      assert.equal(head.headers.get('content-type'), contentType, path);
      assert.equal((await head.arrayBuffer()).byteLength, 0, path);
    }
    const rawPngs = (await readdir(sourcePngDirectory)).filter((name) => name.toLowerCase().endsWith('.png'));
    const privatePaths = [
      '/textures/not-a-preset.webp', '/textures/manifest.json',
      ...texturePaths.map((path) => path.replace(/\.webp$/, '.png')),
      ...rawPngs.map((name) => `/textures/${encodeURIComponent(name)}`),
      ...rawPngs.map((name) => `/assets/source-png/${encodeURIComponent(name)}`),
    ];
    for (const path of privatePaths) {
      assert.equal((await fetch(base + path)).status, 404, path);
      assert.equal((await fetch(base + path, { method: 'HEAD' })).status, 404, path);
    }
    assert.equal(engineCalls, 0);
  } finally {
    await server.close();
  }
  assert.equal(engineClosed, true, 'The resource test must close cleanly without an installed AI engine');
});
