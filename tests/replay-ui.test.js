import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMove, createInitialGame, undoMove } from '../src/shared/rules.js';
import { appFixture, plain, flush } from './helpers/app-fixture.js';

const p = (x, y) => ({ x, y });
const move = (x, y, tx, ty) => ({ from: p(x, y), to: p(tx, ty) });
const sampleMoves = [move(0, 6, 0, 5), move(0, 3, 0, 4), move(0, 5, 0, 4),
  move(2, 3, 2, 4), move(2, 6, 2, 5), move(2, 4, 2, 5)];
const resultFor = (reason) => ['draw', 'repetition', 'no-capture', 'insufficient-material'].includes(reason)
  ? { winner: null, loser: null, reason } : { winner: 'black', loser: 'red', reason };
function played(moves = sampleMoves) {
  let game = createInitialGame();
  for (const { from, to } of moves) {
    const applied = applyMove(game, from, to);
    assert.equal(applied.ok, true, applied.error);
    game = applied.game;
  }
  return game;
}
function ended(reason = 'draw', moves = sampleMoves) { return { ...played(moves), result: resultFor(reason) }; }
const cursor = (app) => Number(app.element('replay-position').value);
const currentRows = (app) => app.element('history').children.filter((row) => row.getAttribute('aria-current') === 'step');
function openReplay(app, entry = 'replay-start') {
  if (entry === 'replay-open') app.click('result-dismiss');
  app.click(entry);
  assert.equal(app.element('replay-panel').hidden, false, `${entry} must open replay`);
  assert.equal(app.element('result-overlay').hidden, true);
}
function navigate(app, index) { app.input('replay-position', index, 'input'); }

test('every authoritative terminal outcome offers replay from its popup and ended-board controls', async (t) => {
  for (const reason of ['draw', 'resignation', 'timeout', 'move-timeout', 'checkmate', 'stalemate',
    'general-captured', 'repetition', 'no-capture', 'insufficient-material', 'perpetual-check', 'perpetual-chase']) {
    await t.test(reason, async (st) => {
      const app = await appFixture(st);
      const finalGame = ended(reason);
      const { socket } = await app.room({ game: finalGame });
      const sent = plain(socket.sent);
      assert.equal(app.element('replay-start').disabled, false);
      assert.equal(app.element('replay-open').disabled, false);
      openReplay(app);
      assert.equal(cursor(app), 0);
      assert.deepEqual(plain(app.game.board), createInitialGame().board);
      assert.equal(app.canSelect, false, 'Replay frames cannot make real moves');
      app.click('replay-exit');
      assert.deepEqual(plain(app.game), finalGame);
      openReplay(app, 'replay-open');
      app.click('replay-exit');
      assert.deepEqual(plain(app.realGame), finalGame);
      assert.deepEqual(socket.sent, sent, 'Entering and exiting replay are client-local');
    });
  }
});

test('zero-move finished games remain inspectable and cannot schedule playback', async (t) => {
  const app = await appFixture(t);
  const finalGame = ended('resignation', []);
  await app.room({ game: finalGame });
  openReplay(app);
  assert.equal(cursor(app), 0);
  for (const id of ['replay-first', 'replay-prev', 'replay-next', 'replay-last']) assert.equal(app.element(id).disabled, true);
  app.click('replay-play');
  app.advance(10_000);
  assert.equal(cursor(app), 0);
  assert.deepEqual(plain(app.game.board), finalGame.board);
  app.click('replay-exit');
  assert.deepEqual(plain(app.realGame), finalGame);
});

test('step navigation restores captures, turn and complete records without touching the final game', async (t) => {
  const app = await appFixture(t);
  const finalGame = ended();
  await app.room({ game: finalGame });
  openReplay(app);
  const records = app.element('history');
  assert.equal(records.children.length, finalGame.history.length, 'The complete final record remains visible at the initial position');
  assert.equal(currentRows(app).length, 0);
  app.click('replay-next');
  assert.equal(cursor(app), 1);
  assert.deepEqual(plain(app.game.board), played(sampleMoves.slice(0, 1)).board);
  assert.equal(app.game.turn, 'black');
  assert.equal(currentRows(app).length, 1);
  assert.equal(currentRows(app)[0], records.children[0]);
  navigate(app, 3);
  assert.equal(app.game.board[4 * 9].side, 'red');
  assert.equal(app.game.board[4 * 9].type, 'pawn');
  app.click('replay-prev');
  assert.equal(cursor(app), 2);
  assert.equal(app.game.board[4 * 9].side, 'black', 'Back restores the captured black pawn');
  app.click('replay-last');
  assert.equal(cursor(app), sampleMoves.length);
  assert.deepEqual(plain(app.game.board), finalGame.board);
  assert.equal(currentRows(app)[0], records.children.at(-1));
  app.click('replay-first');
  assert.equal(cursor(app), 0);
  assert.deepEqual(plain(app.game.board), createInitialGame().board);
  assert.equal(records.children.length, sampleMoves.length);
  assert.match(records.children[2].textContent, /吃黑方卒/);
  app.click('replay-exit');
  assert.deepEqual(plain(app.realGame), finalGame);
});

test('playback uses one and two seconds per ply, pauses immediately and stops at the final position', async (t) => {
  const app = await appFixture(t);
  await app.room({ game: ended() });
  openReplay(app);
  app.input('replay-speed', '1');
  app.click('replay-play');
  assert.match(app.element('replay-play').textContent, /暂停/);
  app.advance(999);
  assert.equal(cursor(app), 0);
  app.advance(1);
  assert.equal(cursor(app), 1);
  app.click('replay-play');
  app.advance(10_000);
  assert.equal(cursor(app), 1, 'Paused playback must not advance');
  app.input('replay-speed', '2');
  app.click('replay-play');
  app.advance(1999);
  assert.equal(cursor(app), 1);
  app.advance(1);
  assert.equal(cursor(app), 2);
  app.advance(8000);
  assert.equal(cursor(app), sampleMoves.length);
  assert.match(app.element('replay-play').textContent, /播放/);
  app.advance(10_000);
  assert.equal(cursor(app), sampleMoves.length, 'Playback ends instead of looping');
});

test('custom seconds govern playback and changing speed cannot leave overlapping timers', async (t) => {
  const app = await appFixture(t);
  await app.room({ game: ended() });
  openReplay(app);
  app.input('replay-speed', 'custom');
  app.input('replay-custom', '0.5');
  app.click('replay-play');
  app.advance(499);
  assert.equal(cursor(app), 0);
  app.advance(1);
  assert.equal(cursor(app), 1);
  app.input('replay-speed', '2');
  const atChange = cursor(app);
  app.advance(500);
  assert.equal(cursor(app), atChange, 'The superseded half-second timer must be cancelled');
  app.advance(1500);
  assert.ok(cursor(app) <= atChange + 1, 'Speed changes cannot produce duplicate advancement');
  if (app.element('replay-play').textContent.includes('播放')) app.click('replay-play');
  const restartedAt = cursor(app);
  app.advance(2000);
  assert.equal(cursor(app), restartedAt + 1);
});

test('clicking a recorded move seeks to that ply and pauses active playback', async (t) => {
  const app = await appFixture(t);
  const finalGame = ended();
  await app.room({ game: finalGame });
  openReplay(app);
  app.click('replay-play');
  app.advance(500);
  app.click(app.element('history').children[3].children[0]);
  assert.equal(cursor(app), 4);
  assert.deepEqual(plain(app.game.board), played(sampleMoves.slice(0, 4)).board);
  assert.match(app.element('replay-play').textContent, /播放/);
  app.advance(10_000);
  assert.equal(cursor(app), 4);
  assert.equal(currentRows(app)[0], app.element('history').children[3]);
  assert.deepEqual(plain(app.realGame), finalGame);
});

test('record highlighting during replay never scrolls a row into view and keeps playback controls available', async (t) => {
  const app = await appFixture(t);
  await app.room({ game: ended() });
  openReplay(app);
  const panel = app.element('replay-panel');
  assert.equal(panel.scrolls.length, 1, 'Entering replay may reveal its controls once');
  const renderedRows = [];
  const inspectHighlight = () => {
    renderedRows.push(...app.element('history').children);
    assert.equal(app.element('replay-panel').hidden, false);
    assert.equal(app.element('replay-play').disabled, false);
    assert.ok(app.element('replay-play').getClientRects().length, 'Playback controls remain available');
    for (const row of renderedRows) assert.equal(row.scrolls?.length ?? 0, 0, 'Highlighting must scroll only the record container');
    assert.equal(panel.scrolls.length, 1, 'Playback and seeking must not reveal the panel repeatedly');
  };
  app.click('replay-next');
  inspectHighlight();
  navigate(app, 3);
  inspectHighlight();
  app.click('replay-prev');
  inspectHighlight();
  app.click(app.element('history').children[4].children[0]);
  inspectHighlight();
  app.input('replay-speed', '1');
  app.click('replay-play');
  app.advance(1000);
  assert.equal(cursor(app), sampleMoves.length);
  inspectHighlight();
});

test('already queued playback callbacks become harmless after pausing, seeking or exiting replay', async (t) => {
  const app = await appFixture(t);
  const finalGame = ended();
  await app.room({ game: finalGame });
  openReplay(app);
  const pendingPlayback = () => {
    const callbacks = [...app.timers.values()].filter((timer) => !timer.interval);
    assert.equal(callbacks.length, 1, 'Exactly one replay timeout should be scheduled');
    return callbacks[0].callback;
  };
  app.click('replay-play');
  const pausedCallback = pendingPlayback();
  app.click('replay-play');
  pausedCallback();
  assert.equal(cursor(app), 0);
  app.click('replay-play');
  const seekCallback = pendingPlayback();
  app.click('replay-next');
  seekCallback();
  assert.equal(cursor(app), 1);
  app.click('replay-play');
  const exitedCallback = pendingPlayback();
  app.click('replay-exit');
  exitedCallback();
  assert.equal(app.element('replay-panel').hidden, true);
  assert.deepEqual(plain(app.game), finalGame);
});

test('invalid custom playback intervals leave a paused, editable replay without timer churn', async (t) => {
  const app = await appFixture(t);
  await app.room({ game: ended() });
  openReplay(app);
  app.input('replay-speed', 'custom');
  for (const seconds of ['', '0', '-1', '3601']) {
    app.input('replay-custom', seconds);
    app.click('replay-play');
    app.advance(3000);
    assert.equal(cursor(app), 0);
    assert.match(app.element('replay-play').textContent, /播放/);
    assert.match(app.element('message').textContent, /间隔.*秒/);
    assert.equal([...app.timers.values()].filter((timer) => !timer.interval).length, 0);
  }
  app.input('replay-custom', '0.1');
  app.click('replay-play');
  app.advance(100);
  assert.equal(cursor(app), 1, 'Correcting the custom interval permits normal playback');
});

test('editing custom seconds before committing the change cannot crash a running playback callback', async (t) => {
  const app = await appFixture(t);
  const finalGame = ended();
  await app.room({ game: finalGame });
  openReplay(app);
  app.input('replay-speed', 'custom');
  app.input('replay-custom', '0.5');
  app.click('replay-play');
  app.input('replay-custom', '', 'input');
  assert.doesNotThrow(() => app.advance(500), 'A temporarily empty number input is normal while editing');
  assert.equal(cursor(app), 1);
  app.advance(500);
  assert.equal(cursor(app), 2, 'Uncommitted editing retains the previously selected half-second interval');
  const scheduled = [...app.timers.values()].filter((timer) => !timer.interval);
  const isPlaying = app.element('replay-play').textContent.includes('暂停');
  assert.equal(isPlaying, true);
  assert.equal(scheduled.length, 1, 'Running playback keeps exactly one pending advancement');
  assert.deepEqual(plain(app.realGame), finalGame);
  app.input('replay-custom', '');
  assert.match(app.element('replay-play').textContent, /播放/);
  app.advance(1000);
  assert.equal(cursor(app), 2, 'Committing invalid input pauses playback without throwing');
  app.input('replay-custom', '0.5');
  if (!app.element('replay-play').textContent.includes('暂停')) app.click('replay-play');
  const before = cursor(app);
  app.advance(500);
  assert.equal(cursor(app), before + 1, 'Valid input restores normal playback');
});

test('sandbox pauses replay, blocks seeking and playback until exit, and never commits its branch', async (t) => {
  const app = await appFixture(t);
  const finalGame = ended();
  const { socket } = await app.room({ game: finalGame });
  const sent = plain(socket.sent);
  openReplay(app);
  app.input('replay-speed', '1');
  app.click('replay-play');
  app.advance(1000);
  assert.equal(cursor(app), 1);
  app.click('sandbox-toggle');
  assert.ok(app.sandbox);
  assert.match(app.element('replay-play').textContent, /播放/);
  for (const id of ['replay-first', 'replay-prev', 'replay-play', 'replay-next', 'replay-last', 'replay-position']) {
    assert.equal(app.element(id).disabled, true, `${id} must be disabled during sandbox analysis`);
    app.click(id, { force: true });
  }
  navigate(app, 5);
  app.advance(5000);
  assert.equal(app.game.turn, 'black');
  app.move(move(2, 3, 2, 4));
  assert.equal(app.sandbox.game.history.length, 1);
  const branch = plain(app.game);
  assert.notDeepEqual(branch.board, played(sampleMoves.slice(0, 1)).board);
  app.advance(5000);
  assert.deepEqual(plain(app.game), branch, 'Paused replay timers cannot overwrite a sandbox branch');
  app.click('sandbox-undo');
  assert.equal(app.sandbox.game.history.length, 0);
  app.move(move(2, 3, 2, 4));
  app.click('sandbox-toggle');
  assert.equal(app.sandbox, null);
  assert.equal(cursor(app), 1);
  assert.deepEqual(plain(app.game.board), played(sampleMoves.slice(0, 1)).board);
  app.advance(5000);
  assert.equal(cursor(app), 1, 'Exiting sandbox keeps replay paused');
  app.click('replay-play');
  app.advance(1000);
  assert.equal(cursor(app), 2);
  assert.deepEqual(plain(app.realGame), finalGame);
  assert.deepEqual(socket.sent, sent);
  assert.equal(app.requests.length, 0, 'Sandbox and replay must not invoke AI');
});

test('replay board clicks and clock updates remain isolated from authoritative room state', async (t) => {
  const app = await appFixture(t);
  const finalGame = ended('timeout');
  const { socket, room } = await app.room({ game: finalGame, clock: { remainingMs: { red: 0, black: 428123 } } });
  const sent = plain(socket.sent);
  const clock = plain(app.roomState.clock);
  openReplay(app);
  app.move(sampleMoves[0]);
  assert.equal(cursor(app), 0);
  app.click('replay-play');
  app.advance(2000);
  socket.receive({ type: 'clock', code: room.code, revision: room.revision, clock: room.clock });
  assert.deepEqual(plain(app.realGame), finalGame);
  assert.deepEqual(plain(app.roomState.clock), clock);
  assert.equal(app.element('time-red').textContent, '00:00');
  assert.equal(app.element('time-black').textContent, '07:09');
  assert.deepEqual(socket.sent, sent);
  assert.equal(app.requests.length, 0);
  app.click('replay-exit');
  app.advance(20_000);
  assert.deepEqual(plain(app.game), finalGame);
});

test('authoritative undo or a new round closes replay and invalidates its pending timer', async (t) => {
  for (const transition of ['undo', 'new-round']) {
    await t.test(transition, async (st) => {
      const app = await appFixture(st);
      const finalGame = ended('repetition');
      const { socket, room } = await app.room({ game: finalGame });
      openReplay(app);
      app.click('replay-play');
      app.advance(500);
      const nextGame = transition === 'undo' ? undoMove(finalGame) : createInitialGame();
      socket.receive({ type: 'state', room: { ...room, game: nextGame, revision: room.revision + 1,
        round: transition === 'new-round' ? room.round + 1 : room.round,
        clock: { ...room.clock, runningSide: nextGame.turn } } });
      assert.equal(app.element('replay-panel').hidden, true);
      app.advance(5000);
      assert.deepEqual(plain(app.game), nextGame);
      assert.equal(app.sandbox, null);
    });
  }
});

test('unchanged authoritative snapshots and presence updates preserve the current replay and its playback deadline', async (t) => {
  const app = await appFixture(t);
  const finalGame = ended();
  const { socket, room } = await app.room({ game: finalGame });
  openReplay(app);
  app.input('replay-speed', '1');
  app.click('replay-play');
  app.advance(500);
  socket.receive({ type: 'state', room: { ...room, players: { red: true, black: false } } });
  assert.equal(app.element('replay-panel').hidden, false);
  assert.equal(cursor(app), 0);
  app.advance(500);
  assert.equal(cursor(app), 1);
  socket.receive({ type: 'state', room });
  assert.equal(cursor(app), 1);
  app.advance(1000);
  assert.equal(cursor(app), 2);
  assert.deepEqual(plain(app.realGame), finalGame);
});

test('local repetition replays only the final history after an undone alternate move', async (t) => {
  const app = await appFixture(t);
  app.move(move(0, 6, 0, 5));
  app.click('undo');
  const cycle = [move(1, 9, 2, 7), move(1, 0, 2, 2), move(2, 7, 1, 9), move(2, 2, 1, 0)];
  for (let i = 0; i < 8; i++) app.move(cycle[i % 4]);
  const finalGame = plain(app.realGame);
  assert.equal(finalGame.result.reason, 'repetition');
  assert.equal(finalGame.history.length, 8);
  openReplay(app);
  assert.equal(app.element('history').children.length, 8);
  assert.ok(app.element('history').children.every((row) => !row.textContent.includes('兵')));
  app.click('replay-last');
  assert.deepEqual(plain(app.game.board), finalGame.board);
  app.click('replay-exit');
  assert.deepEqual(plain(app.realGame), finalGame);
});

test('mode changes clear replay playback before local, restart, AI start or reconnect renders another game', async (t) => {
  for (const action of ['local', 'restart', 'ai-start', 'create']) {
    await t.test(action, async (st) => {
      const app = await appFixture(st);
      if (action === 'restart' || action === 'create') {
        const cycle = [move(1, 9, 2, 7), move(1, 0, 2, 2), move(2, 7, 1, 9), move(2, 2, 1, 0)];
        for (let i = 0; i < 8; i++) app.move(cycle[i % 4]);
      } else await app.room({ game: ended() });
      openReplay(app);
      app.click('replay-play');
      app.advance(500);
      if (action === 'ai-start') app.input('ai-side', 'red');
      app.click(action);
      await flush();
      assert.equal(app.element('replay-panel').hidden, true);
      const actual = plain(app.realGame);
      app.advance(action === 'create' ? 1500 : 5000);
      assert.deepEqual(plain(app.game), actual, 'A stale replay callback cannot replace the newly selected game');
      assert.equal(app.sandbox, null);
    });
  }
});

test('endgame analysis is visibly reserved without activating another game or network action', async (t) => {
  const app = await appFixture(t);
  const finalGame = ended();
  const { socket } = await app.room({ game: finalGame });
  openReplay(app);
  const placeholder = app.element('endgame-placeholder');
  assert.equal(placeholder.disabled, true);
  assert.match(placeholder.textContent, /残局/);
  const sent = plain(socket.sent);
  app.click('endgame-placeholder');
  assert.deepEqual(plain(app.realGame), finalGame);
  assert.deepEqual(socket.sent, sent);
});
