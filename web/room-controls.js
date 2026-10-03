const colors = ['red', 'black'];
const sideName = (side) => side === 'red' ? '红方' : '黑方';
export const roomIsPlaying = (room) => !room || (room.phase ? room.phase === 'playing' : Boolean(room.clock?.started));

export function restartDescription(config, side) {
  if (!config) return '同意后重置棋局，双方重新准备。';
  const first = config.redSide === side ? '你执红先行，对方执黑' : '对方执红先行，你执黑';
  const minutes = (ms) => Number((ms / 60_000).toFixed(2));
  const time = config.timed ? `红方 ${minutes(config.timeControl.red)} 分钟，黑方 ${minutes(config.timeControl.black)} 分钟` : '不计时';
  return `下一局：${first}；${time}。同意后进入准备阶段，双方准备后倒数 3 秒开局。`;
}

export function readTimes(document, prefix = '') {
  const times = {};
  for (const color of colors) {
    const choice = document.getElementById(`${prefix}${color}-time-choice`).value;
    const input = document.getElementById(`${prefix}${color}-time-custom`);
    const value = choice === 'custom' ? input.value.trim() : choice;
    const minutes = Number(value);
    if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(value) || minutes < 0.1 || minutes > 180) {
      input.focus();
      throw new Error(`${sideName(color)}总时间请输入 0.1–180 分钟，最多两位小数`);
    }
    times[color] = Math.round(minutes * 60_000);
  }
  return times;
}

export function createRoomControls({ document, getState, onReady, onRestart, notify, now }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $('restart-config');
  let editorRound = null;
  function close() {
    if (dialog.open) dialog.close();
    editorRound = null;
  }
  function timeInputs(prefix) {
    for (const color of colors) {
      const select = $(`${prefix}${color}-time-choice`);
      select.addEventListener('change', () => {
        const custom = select.value === 'custom';
        $(`${prefix}${color}-custom-label`).hidden = !custom;
        if (custom) $(`${prefix}${color}-time-custom`).focus();
      });
    }
  }
  timeInputs('');
  timeInputs('restart-');
  function timing(prefix, checkbox) {
    $(`${prefix}time-options`).hidden = !checkbox.checked;
  }
  $('timed-toggle').addEventListener('change', () => timing('', $('timed-toggle')));
  $('restart-timed').addEventListener('change', () => timing('restart-', $('restart-timed')));
  $('ready-button').addEventListener('click', () => {
    const { room, side, connected, busy } = getState();
    if (!room || room.phase !== 'preparing' || !connected || busy || room.pendingRestart) return;
    onReady({ type: 'ready', ready: !room.ready?.[side], round: room.round });
  });
  $('restart-cancel').addEventListener('click', close);
  $('restart-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const { room, connected, busy } = getState();
    if (!room || `${room.code}:${room.round}` !== editorRound || !connected || busy || room.phase === 'countdown') return;
    let timeControl;
    const timed = $('restart-timed').checked;
    try { timeControl = timed ? readTimes(document, 'restart-') : { ...room.clock.initialMs }; }
    catch (error) { $('restart-config-error').textContent = error.message; return; }
    const message = { type: 'restart-request', revision: room.revision,
      config: { redSide: $('restart-red-side').value, timed, timeControl } };
    close();
    onRestart(message);
  });
  function open() {
    const { room, side, connected, busy } = getState();
    if (!room || !connected || busy || !room.players.red || !room.players.black || room.phase === 'countdown') return;
    editorRound = `${room.code}:${room.round}`;
    $('restart-own-red').value = side;
    $('restart-other-red').value = side === 'red' ? 'black' : 'red';
    $('restart-red-side').value = 'red';
    $('restart-timed').checked = room.clock.enabled !== false;
    timing('restart-', $('restart-timed'));
    for (const color of colors) {
      const minutes = String(Number((room.clock.initialMs[color] / 60_000).toFixed(2)));
      const preset = ['10', '15'].includes(minutes);
      $(`restart-${color}-time-choice`).value = preset ? minutes : 'custom';
      $(`restart-${color}-time-custom`).value = minutes;
      $(`restart-${color}-custom-label`).hidden = preset;
    }
    $('restart-config-error').textContent = '';
    dialog.showModal();
    $('restart-red-side').focus();
  }
  function renderCountdown() {
    const { room, receivedAt } = getState();
    const counting = room?.phase === 'countdown';
    $('start-countdown').hidden = !counting;
    if (!counting) return;
    const remaining = Math.max(0, room.countdownMs - Math.max(0, now() - receivedAt));
    const text = String(Math.max(1, Math.ceil(remaining / 1000)));
    if ($('countdown-number').textContent !== text) $('countdown-number').textContent = text;
  }
  function render() {
    const { room, side, connected, busy } = getState();
    const preparing = room && !roomIsPlaying(room);
    $('ready-panel').hidden = !preparing;
    if (preparing) {
      const opponent = side === 'red' ? 'black' : 'red';
      for (const [id, color, label] of [['own-ready-status', side, '你'], ['opponent-ready-status', opponent, '对方']]) {
        const ready = room.ready?.[color] && room.players[color];
        $(id).textContent = `${label}（${sideName(color)}）：${!room.players[color] ? '未连接' : ready ? '已准备' : '未准备'}`;
        $(id).classList.toggle('is-ready', Boolean(ready));
      }
      $('ready-button').textContent = room.ready?.[side] ? '取消准备' : '准备好了';
      $('ready-button').disabled = !connected || busy || room.phase === 'countdown';
    }
    if (dialog.open && (!room || `${room.code}:${room.round}` !== editorRound || !connected || busy || !room.players.red || !room.players.black)) {
      close();
      notify('房间状态已变化，请重新配置下一局');
    }
    renderCountdown();
  }
  return { open, close, render, renderCountdown };
}
