import { pieceGlyph } from '/piece-glyph.js';

// Appearance stays in this client: it never enters a room message or game state.
const storageKey = 'xiangqi-appearance-v1';
const fonts = {
  running: { family: 'Xiangqi Running', label: '行书' },
  kai: { family: 'Xiangqi Kai', label: '楷体' },
  cursive: { family: 'Xiangqi Xingkai', label: '草书' },
};
const skins = new Set(['ivory', 'celadon', 'mist', 'lotus', 'beech', 'walnut']);
const characters = '帅仕相马车炮兵将士象砲卒楚河汉界';
const board = document.getElementById('board');
const fontChoice = document.getElementById('board-font');
const skinChoices = document.querySelectorAll('input[name="board-skin"]');
const status = document.getElementById('appearance-status');
let preferences = { font: 'running', skin: 'ivory' };
let canSave = true;
let fontRequest = 0;

// Previews use the same baseline and sizing mechanism as the actual pieces.
document.querySelectorAll('.skin-swatch').forEach((swatch) => {
  for (const [color, character] of [['red', '帅'], ['black', '将']]) {
    const piece = document.createElement('span');
    piece.className = `swatch-piece ${color}`;
    piece.append(pieceGlyph(character));
    swatch.append(piece);
  }
});

try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  if (saved && Object.hasOwn(fonts, saved.font)) preferences.font = saved.font;
  if (saved && skins.has(saved.skin)) preferences.skin = saved.skin;
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

async function chooseFont(value) {
  if (!Object.hasOwn(fonts, value)) return;
  const request = ++fontRequest;
  fontChoice.value = value;
  showStatus('正在载入自带字库…');
  try {
    // Load the complete bundled fallback before changing the primary font.
    const loaded = await Promise.all([...new Set(['Xiangqi Kai', fonts[value].family])]
      .map((family) => document.fonts.load(`38px "${family}"`, characters)));
    if (loaded.some((faces) => !faces.length)) throw new Error('Bundled font unavailable');
    if (request !== fontRequest) return;
    board.dataset.font = value;
    document.documentElement.dataset.font = value;
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
skinChoices.forEach((input) => {
  input.checked = input.value === preferences.skin;
  input.addEventListener('change', () => {
    if (!input.checked || !skins.has(input.value)) return;
    board.dataset.skin = preferences.skin = input.value;
    save();
    showStatus();
  });
});
fontChoice.addEventListener('change', () => { void chooseFont(fontChoice.value); });
void chooseFont(preferences.font);
