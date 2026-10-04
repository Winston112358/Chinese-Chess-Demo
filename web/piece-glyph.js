import { clericalMetrics } from './fonts/clerical-metrics.js';
import { clericalSquareMetrics } from './fonts/clerical-square-metrics.js';

const svgNamespace = 'http://www.w3.org/2000/svg';
const traditionalCharacters = { 帅: '帥', 将: '將', 马: '馬', 车: '車', 汉: '漢' };
const redTraditionalCharacters = { 马: '傌', 车: '俥' };
const originalFontMetrics = { clerical: clericalMetrics, 'clerical-square': clericalSquareMetrics };

// Lettering is local presentation; the shared game always keeps canonical names.
export function chessCharacters(text, font = document.documentElement.dataset.font, side) {
  if (!Object.hasOwn(originalFontMetrics, font)) return text;
  return text.replace(/[帅将马车汉]/g, (character) => side === 'red'
    ? redTraditionalCharacters[character] ?? traditionalCharacters[character] : traditionalCharacters[character]);
}

export function setPieceGlyph(glyph, character, font = document.documentElement.dataset.font, side = glyph.getAttribute('data-side')) {
  glyph.setAttribute('data-character', character);
  if (side) glyph.setAttribute('data-side', side);
  setChessText(glyph.firstElementChild, character, font, side);
}

// The original clerical TTF is kept intact; only its on-screen geometry changes.
export function setChessText(text, character, font = document.documentElement.dataset.font, side) {
  const display = chessCharacters(character, font, side);
  const size = Number(text.getAttribute('data-letter-size') ?? 1000);
  const centerX = Number(text.getAttribute('data-center-x') ?? 500);
  const centerY = Number(text.getAttribute('data-center-y') ?? 500);
  text.textContent = display;
  text.setAttribute('font-size', String(size));
  text.setAttribute('x', String(centerX));
  text.setAttribute('y', String(centerY + size * .3));
  const fontMetrics = originalFontMetrics[font];
  const metrics = fontMetrics?.glyphs[display];
  if (metrics) {
    const inkX = centerX + (metrics.renderCenterX - 500) * size / 1000;
    const inkY = centerY + (metrics.renderCenterY - 500) * size / 1000;
    text.setAttribute('transform', `translate(${centerX} ${centerY}) scale(${fontMetrics.commonScale}) translate(${-inkX} ${-inkY})`);
  } else text.setAttribute('transform', '');
}

export function refreshChessGlyphs(scope = document, font = document.documentElement.dataset.font) {
  for (const glyph of scope.querySelectorAll('.piece-glyph')) {
    setPieceGlyph(glyph, glyph.getAttribute('data-character'), font);
  }
  for (const river of scope.querySelectorAll('.board-river text')) {
    setChessText(river, river.getAttribute('data-character'), font);
  }
}

// Bundled fonts use a 1000-unit advance and ink center (500, 300).
// Baseline y=800 places that ink center at (500, 500) in this square,
// without depending on a browser's rounded line-box ascent/descent.
export function pieceGlyph(character, side) {
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.setAttribute('class', 'piece-glyph');
  svg.setAttribute('viewBox', '0 0 1000 1000');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const text = document.createElementNS(svgNamespace, 'text');
  text.setAttribute('x', '500');
  text.setAttribute('y', '800');
  text.setAttribute('font-size', '1000');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('fill', 'currentColor');
  svg.append(text);
  setPieceGlyph(svg, character, document.documentElement.dataset.font, side);
  return svg;
}
