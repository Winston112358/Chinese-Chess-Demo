// Return to the position before the player's most recent move. The computer's
// opening move alone cannot be undone: there is no player decision to revisit.
export function aiUndoCount(game, humanSide) {
  const lastHumanMove = game.history.findLastIndex((move) => move.piece.side === humanSide);
  return lastHumanMove < 0 ? 0 : game.history.length - lastHumanMove;
}

// A cancelled search must stay cancelled even when a response was already in
// transit or a transport ignores AbortSignal. Only the newest request can win.
export function createAiSearch({ fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  let generation = 0;
  let active = null;

  function cancel() {
    generation++;
    active?.abort();
    active = null;
  }

  async function search(game) {
    cancel();
    const current = generation;
    const controller = new AbortController();
    active = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await fetchImpl('/api/ai/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ history: game.history.map(({ from, to }) => ({ from, to })) }),
        signal: controller.signal,
      });
      const data = await response.json();
      if (current !== generation) return null;
      if (timedOut) throw new Error('皮卡鱼响应超时，请重试');
      if (!response.ok || data.error) throw new Error(data.error || '皮卡鱼暂时无法走棋，请重试');
      if (!data.move?.from || !data.move?.to) throw new Error('皮卡鱼没有返回有效着法，请重试');
      return data.move;
    } catch (error) {
      if (current !== generation) return null;
      if (timedOut) throw new Error('皮卡鱼响应超时，请重试');
      throw error;
    } finally {
      clearTimeout(timer);
      if (current === generation) active = null;
    }
  }

  return { search, cancel };
}
