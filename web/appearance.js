import { pieceGlyph, chessCharacters, refreshChessGlyphs } from '/piece-glyph.js';
import { boardSkins, pieceSkins } from '/appearance-presets.js';
import { pieceTone } from '/appearance-colors.js';

// Appearance stays in this client: it never enters a room message or game state.
const storageKey = 'xiangqi-appearance-v1';
const fonts = {
  running: { family: 'Xiangqi Running', label: '行书' },
  kai: { family: 'Xiangqi Kai', label: '楷体' },
  cursive: { family: 'Xiangqi Xingkai', label: '草书' },
  regular: { family: 'Xiangqi Regular', label: '正楷' },
  clerical: { family: 'Xiangqi Clerical', label: '隶书' },
  'clerical-square': { family: 'Xiangqi Clerical Square', label: '隶书 · 教育部（方整）' },
};
const boardSkinIds = new Set(boardSkins.map(({ id }) => id));
const pieceSkinIds = new Set(pieceSkins.map(({ id }) => id));
const characters = '帅仕相马车炮兵将士象砲卒楚河汉界';
const board = document.getElementById('board');
const fontChoice = document.getElementById('board-font');
const boardSkinChoices = document.querySelectorAll('input[name="board-skin"]');
const pieceSkinChoices = document.querySelectorAll('input[name="piece-skin"]');
const boardPreviews = document.querySelectorAll('.skin-swatch');
const piecePreviews = document.querySelectorAll('.piece-swatch');
const status = document.getElementById('appearance-status');
const boardSkinCurrent = document.getElementById('board-skin-current');
const pieceSkinCurrent = document.getElementById('piece-skin-current');
let preferences = { font: 'running', skin: 'ivory', pieceSkin: 'ivory' };
let canSave = true;
let fontRequest = 0;

// Previews use the same baseline and sizing mechanism as the actual pieces.
[...boardPreviews, ...piecePreviews].forEach((swatch) => {
  for (const [color, character] of [['red', '帅'], ['black', '将']]) {
    const piece = document.createElement('span');
    piece.className = `swatch-piece ${color}`;
    piece.append(pieceGlyph(character, color));
    swatch.append(piece);
  }
});
piecePreviews.forEach((swatch) => { swatch.dataset.pieceTone = 'light'; });

try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (saved && Object.hasOwn(fonts, saved.font)) preferences.font = saved.font;
  if (saved && boardSkinIds.has(saved.skin)) preferences.skin = saved.skin;
  if (saved && pieceSkinIds.has(saved.pieceSkin)) preferences.pieceSkin = saved.pieceSkin;
} catch {
  canSave = false;
}

function save() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(preferences));
    canSave = true;
  } catch {
    canSave = false;
  }
}

function showStatus(text = '') {
  status.textContent = [text, canSave ? '' : '当前环境无法保存偏好，本次选择仍然有效。'].filter(Boolean).join(' ');
}

function updateSummaryNames() {
  if (boardSkinCurrent) {
    boardSkinCurrent.textContent = boardSkins.find(({ id }) => id === preferences.skin)?.label ?? '';
  }
  if (pieceSkinCurrent) {
    pieceSkinCurrent.textContent = pieceSkins.find(({ id }) => id === preferences.pieceSkin)?.label ?? '';
  }
}

function applyPieceSkin(value) {
  const tone = pieceTone(preferences.skin, value);
  board.dataset.pieceSkin = value;
  board.dataset.pieceTone = tone;
  document.documentElement.dataset.pieceSkin = value;
  document.documentElement.dataset.pieceTone = tone;
  boardPreviews.forEach((swatch) => {
    swatch.dataset.pieceSkin = value;
    swatch.dataset.pieceTone = pieceTone(swatch.dataset.skin, value);
  });
  updateSummaryNames();
}

async function chooseFont(value) {
  if (!Object.hasOwn(fonts, value)) return;
  const request = ++fontRequest;
  fontChoice.value = value;
  showStatus('正在载入自带字库…');
  try {
    // Load the complete bundled fallback before changing the primary font.
    const loaded = await Promise.all([...new Set(['Xiangqi Kai', fonts[value].family])]
      .map((family) => document.fonts.load(`38px "${family}"`, [...new Set(
        chessCharacters(characters, value, 'red') + chessCharacters(characters, value, 'black')
      )].join(''))));
    if (loaded.some((faces) => !faces.length)) throw new Error('Bundled font unavailable');
    if (request !== fontRequest) return;
    board.dataset.font = value;
    document.documentElement.dataset.font = value;
    refreshChessGlyphs(document, value);
    preferences.font = value;
    save();
    showStatus(`已应用${fonts[value].label}。`);
  } catch {
    if (request !== fontRequest) return;
    fontChoice.value = board.dataset.font;
    showStatus('字库载入失败，请刷新后重试；已保留当前字体。');
  }
}

board.dataset.skin = preferences.skin;
boardSkinChoices.forEach((input) => {
  input.checked = input.value === preferences.skin;
  input.addEventListener('change', () => {
    if (!input.checked || !boardSkinIds.has(input.value)) return;
    board.dataset.skin = preferences.skin = input.value;
    applyPieceSkin(preferences.pieceSkin);
    save();
    showStatus();
  });
});
applyPieceSkin(preferences.pieceSkin);
pieceSkinChoices.forEach((input) => {
  input.checked = input.value === preferences.pieceSkin;
  input.addEventListener('change', () => {
    if (!input.checked || !pieceSkinIds.has(input.value)) return;
    preferences.pieceSkin = input.value;
    applyPieceSkin(preferences.pieceSkin);
    save();
    showStatus();
  });
});
fontChoice.addEventListener('change', () => { void chooseFont(fontChoice.value); });
void chooseFont(preferences.font);
