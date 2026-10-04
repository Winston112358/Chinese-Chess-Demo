import test from 'node:test';
import assert from 'node:assert/strict';
import { chessCharacters, setPieceGlyph, setChessText, refreshChessGlyphs } from '../web/piece-glyph.js';
import { clericalMetrics } from '../web/fonts/clerical-metrics.js';
import { clericalSquareMetrics } from '../web/fonts/clerical-square-metrics.js';

const canonical = '帅仕相马车炮兵将士象砲卒楚河汉界';
const originalFonts = [['clerical', clericalMetrics], ['clerical-square', clericalSquareMetrics]];
const textNode = (textContent = '', attributes = []) => ({
  textContent,
  attributes: new Map(attributes),
  setAttribute(name, value) { this.attributes.set(name, value); },
  getAttribute(name) { return this.attributes.get(name) ?? null; },
});
const glyph = (character, side) => ({
  attributes: new Map([['data-character', character], ['data-side', side]]),
  firstElementChild: textNode(character),
  setAttribute(name, value) { this.attributes.set(name, value); },
  getAttribute(name) { return this.attributes.get(name) ?? null; },
});

test('four simplified faces preserve canonical piece and river characters', () => {
  for (const font of ['running', 'kai', 'cursive', 'regular']) {
    for (const side of ['red', 'black']) assert.equal(chessCharacters(canonical, font, side), canonical);
  }
});

test('both clerical fonts use traditional characters and distinct red and black horses and rooks', () => {
  for (const [font] of originalFonts) {
    assert.equal(chessCharacters(canonical, font, 'red'), '帥仕相傌俥炮兵將士象砲卒楚河漢界');
    assert.equal(chessCharacters(canonical, font, 'black'), '帥仕相馬車炮兵將士象砲卒楚河漢界');
    assert.equal(chessCharacters('楚 河 汉 界', font), '楚 河 漢 界');
  }
});

test('a reused glyph keeps its canonical character and updates its side', () => {
  const rook = glyph('车', 'red');
  setPieceGlyph(rook, '车', 'clerical');
  assert.equal(rook.firstElementChild.textContent, '俥');
  assert.match(rook.firstElementChild.getAttribute('transform'), /^translate/);
  assert.equal(rook.getAttribute('data-character'), '车');
  setPieceGlyph(rook, '车', 'clerical', 'black');
  assert.equal(rook.firstElementChild.textContent, '車');
  setPieceGlyph(rook, '马', 'regular', 'red');
  assert.equal(rook.firstElementChild.textContent, '马');
  assert.equal(rook.firstElementChild.getAttribute('transform'), '', 'Returning to normalized fonts removes the original-font correction');
  assert.equal(rook.getAttribute('data-character'), '马');
  assert.equal(rook.getAttribute('data-side'), 'red');
});

test('both clerical font changes immediately refresh board, captured, preview and river lettering', () => {
  for (const [font] of originalFonts) {
    const pieces = [glyph('车', 'red'), glyph('车', 'black'), glyph('帅', 'red'), glyph('将', 'black'), glyph('马', 'red'), glyph('马', 'black')];
    const river = textNode('汉', [['data-character', '汉'], ['data-letter-size', '48'], ['data-center-x', '342'], ['data-center-y', '300']]);
    const scope = { querySelectorAll(selector) { return selector === '.piece-glyph' ? pieces : [river]; } };
    refreshChessGlyphs(scope, font);
    assert.deepEqual(pieces.map((piece) => piece.firstElementChild.textContent), ['俥', '車', '帥', '將', '傌', '馬']);
    assert.equal(pieces[4].firstElementChild.getAttribute('transform'), '', 'Missing red 傌 must use the bundled Kai geometry');
    assert.match(pieces[5].firstElementChild.getAttribute('transform'), /^translate/, 'Black 馬 must use the native clerical outline');
    assert.equal(river.textContent, '漢');
    assert.equal(river.getAttribute('font-size'), '48');
    assert.equal(river.getAttribute('x'), '342');
    assert.equal(river.getAttribute('y'), '314.4');
    assert.match(river.getAttribute('transform'), /^translate\(342 300\)/);
    assert.equal(pieces[0].firstElementChild.getAttribute('transform') === '', font === 'clerical-square');
    refreshChessGlyphs(scope, 'kai');
    assert.deepEqual(pieces.map((piece) => piece.firstElementChild.textContent), ['车', '车', '帅', '将', '马', '马']);
    assert.equal(river.textContent, '汉');
    assert.equal(river.getAttribute('transform'), '');
  }
});

test('red 傌 falls back without a native transform and changing sides or faces restores the correct horse', () => {
  const horse = glyph('马', 'black');
  for (const [font, metrics] of originalFonts) {
    assert.ok(!metrics.glyphs['傌'], `${font} must not borrow the 馬 metrics for its missing 傌`);
    setPieceGlyph(horse, '马', font, 'black');
    assert.equal(horse.firstElementChild.textContent, '馬');
    assert.match(horse.firstElementChild.getAttribute('transform'), /^translate/);
    setPieceGlyph(horse, '马', font, 'red');
    assert.equal(horse.firstElementChild.textContent, '傌');
    assert.equal(horse.firstElementChild.getAttribute('transform'), '');
    assert.equal(horse.firstElementChild.getAttribute('x'), '500');
    assert.equal(horse.firstElementChild.getAttribute('y'), '800');
    assert.equal(horse.getAttribute('data-character'), '马');
    assert.equal(horse.getAttribute('data-side'), 'red');
    for (const normalized of ['running', 'kai', 'cursive', 'regular']) {
      setPieceGlyph(horse, '马', normalized);
      assert.equal(horse.firstElementChild.textContent, '马');
      assert.equal(horse.firstElementChild.getAttribute('transform'), '');
      setPieceGlyph(horse, '马', font);
      assert.equal(horse.firstElementChild.textContent, '傌');
      assert.equal(horse.firstElementChild.getAttribute('transform'), '');
    }
  }
});

test('each original clerical glyph uses its own measured ink center and one common scale at every display size', () => {
  for (const [font, metrics] of originalFonts) {
    assert.ok(metrics.commonScale > 0 && metrics.commonScale <= 1, font);
    for (const [character, measured] of Object.entries(metrics.glyphs)) {
      for (const [size, centerX, centerY] of [[1000, 500, 500], [48, 342, 300], [21, 10.5, 10.5]]) {
        const text = textNode('', [['data-letter-size', String(size)],
          ['data-center-x', String(centerX)], ['data-center-y', String(centerY)]]);
        setChessText(text, character, font);
        assert.equal(text.textContent, character, `${font} ${character}`);
        assert.equal(Number(text.getAttribute('font-size')), size);
        assert.equal(Number(text.getAttribute('x')), centerX);
        assert.equal(Number(text.getAttribute('y')), centerY + size * .3);
        const transform = text.getAttribute('transform').match(/^translate\((\S+) (\S+)\) scale\((\S+)\) translate\((\S+) (\S+)\)$/);
        assert.ok(transform, `${font} ${character} must use native-font geometry`);
        const [outerX, outerY, scale, innerX, innerY] = transform.slice(1).map(Number);
        assert.equal(scale, metrics.commonScale, `${font} must have a consistent visual size across characters`);
        const inkX = centerX + (measured.renderCenterX - 500) * size / 1000;
        const inkY = centerY + (measured.renderCenterY - 500) * size / 1000;
        assert.ok(Math.abs(outerX + scale * (inkX + innerX) - centerX) < 1e-9, `${font} ${character} horizontal ink center`);
        assert.ok(Math.abs(outerY + scale * (inkY + innerY) - centerY) < 1e-9, `${font} ${character} vertical ink center`);
        const radius = measured.controlRadiusUnits * 1000 / metrics.unitsPerEm * scale;
        assert.ok(radius <= 475, `${font} ${character} ink radius ${radius} must stay within its circle`);
      }
    }
  }
});

test('switching original clerical fonts uses the matching metrics and clears corrections for missing 俥 and 砲', () => {
  for (const [canonicalCharacter, display, side] of [['车', '俥', 'red'], ['砲', '砲', 'black']]) {
    const piece = glyph(canonicalCharacter, side);
    setPieceGlyph(piece, canonicalCharacter, 'clerical');
    assert.match(piece.firstElementChild.getAttribute('transform'), /^translate/);
    setPieceGlyph(piece, canonicalCharacter, 'clerical-square');
    assert.equal(piece.firstElementChild.textContent, display);
    assert.equal(piece.firstElementChild.getAttribute('transform'), '', 'Kai fallback must retain its normalized baseline and center');
    assert.equal(piece.firstElementChild.getAttribute('x'), '500');
    assert.equal(piece.firstElementChild.getAttribute('y'), '800');
    assert.equal(piece.firstElementChild.getAttribute('font-size'), '1000');
    assert.equal(piece.getAttribute('data-character'), canonicalCharacter);
    setPieceGlyph(piece, canonicalCharacter, 'clerical');
    assert.match(piece.firstElementChild.getAttribute('transform'), /^translate/);
  }
  const native = glyph('车', 'black');
  setPieceGlyph(native, '车', 'clerical');
  const aoyagiTransform = native.firstElementChild.getAttribute('transform');
  setPieceGlyph(native, '车', 'clerical-square');
  const squareTransform = native.firstElementChild.getAttribute('transform');
  assert.notEqual(squareTransform, aoyagiTransform, 'The two original fonts must not share different glyph metrics');
  assert.ok(squareTransform.includes(`scale(${clericalSquareMetrics.commonScale})`));
  assert.equal(native.firstElementChild.textContent, '車');
});
