// Game state: the single shared snapshot of match progress, plus a tiny
// event emitter main.js and the other modules use to talk to each other.
// Phases: 'menu' | 'buy' | 'live' | 'roundEnd' | 'matchEnd'.
// Events: 'shot' (pos), 'kill', 'roundEnd', 'bombPlanted', 'bombDefused',
// 'explosion', 'damage'.

export function createGameState() {
  const listeners = new Map();

  const state = {
    phase: 'menu',
    round: 0,
    wins: { ct: 0, t: 0 },
    money: 800,
    timer: 0,
    streak: 0,
    kills: { ct: 0, t: 0 },

    on(evt, fn) {
      if (typeof fn !== 'function') return;
      let fns = listeners.get(evt);
      if (!fns) {
        fns = [];
        listeners.set(evt, fns);
      }
      fns.push(fn);
    },

    emit(evt, data) {
      const fns = listeners.get(evt);
      if (!fns) return;
      for (const fn of fns.slice()) fn(data);
    },
  };

  return state;
}
