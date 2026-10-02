const svgNamespace = 'http://www.w3.org/2000/svg';

// Bundled fonts use a 1000-unit advance and ink center (500, 300).
// Baseline y=800 places that ink center at (500, 500) in this square,
// without depending on a browser's rounded line-box ascent/descent.
export function pieceGlyph(character) {
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
  text.textContent = character;
  svg.append(text);
  return svg;
}
