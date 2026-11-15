// Rounds + economy: buy phase, round timer, win/loss rewards, match end.
// The player is always on the attacker team ('t'). state.streak counts
// consecutive rounds lost by the attackers, which raises the loss bonus.
import { WEAPONS, GRENADE, ARMOR } from './weapon.js';

export const BUY_TIME = 12;
export const ROUND_TIME = 100;
export const WIN_ROUNDS = 5;
export const START_MONEY = 800;
export const KILL_REWARD = 300;
export const WIN_REWARD = 3250;
export const LOSS_REWARD = 1900;
export const LOSS_STEP = 500;
export const LOSS_CAP = 3400;

export function createRounds(state, events, hooks) {
  const h = hooks || {};
  let armorBought = false;
  let grenadesBought = 0;

  // Kill rewards: listen on the event bus when one is supplied (the state
  // emitter itself if main passes it). A kill with byPlayer === false was
  // scored by a friendly bot, so it pays nothing to the player.
  const bus = events && typeof events.on === 'function' ? events : null;
  if (bus) {
    bus.on('kill', (data) => {
      if (state.phase !== 'live') return;
      if (data && data.byPlayer === false) return;
      if (data) {
        const team = data.killerTeam || data.team;
        if (team && state.kills[team] !== undefined) state.kills[team] += 1;
      }
      state.money += KILL_REWARD;
      if (h.onMoneyChange) h.onMoneyChange(state.money);
    });
  }

  function buy(itemId) {
    let price = -1;
    if (itemId === GRENADE.id) {
      if (grenadesBought >= GRENADE.max) {
        if (h.onBuyResult) h.onBuyResult(itemId, false);
        return false;
      }
      price = GRENADE.price;
    } else if (itemId === ARMOR.id) {
      if (armorBought) {
        if (h.onBuyResult) h.onBuyResult(itemId, false);
        return false;
      }
      price = ARMOR.price;
    } else if (WEAPONS[itemId]) {
      price = WEAPONS[itemId].price;
    } else {
      if (h.onBuyResult) h.onBuyResult(itemId, false);
      return false;
    }
    if (state.phase !== 'buy') {
      if (h.onBuyResult) h.onBuyResult(itemId, false);
      return false;
    }
    if (state.money < price) {
      if (h.onBuyResult) h.onBuyResult(itemId, false);
      return false;
    }
    state.money -= price;
    if (itemId === GRENADE.id) grenadesBought += 1;
    if (itemId === ARMOR.id) armorBought = true;
    if (h.onMoneyChange) h.onMoneyChange(state.money);
    if (h.onBuyResult) h.onBuyResult(itemId, true);
    return true;
  }

  function startRound(n) {
    state.round = n;
    state.phase = 'buy';
    state.timer = BUY_TIME;
    armorBought = false;
    grenadesBought = 0;
    if (h.onRoundStart) h.onRoundStart(n);
  }

  function startMatch() {
    state.wins.ct = 0;
    state.wins.t = 0;
    state.kills.ct = 0;
    state.kills.t = 0;
    state.money = START_MONEY;
    state.streak = 0;
    if (h.onMoneyChange) h.onMoneyChange(state.money);
    startRound(1);
  }

  function endRound(winner, reason) {
    if (state.phase !== 'live') return;
    if (winner !== 'ct' && winner !== 't') return;
    state.wins[winner] += 1;
    let reward;
    if (winner === 't') {
      state.streak = 0;
      reward = WIN_REWARD;
    } else {
      state.streak += 1;
      reward = Math.min(LOSS_REWARD + LOSS_STEP * (state.streak - 1), LOSS_CAP);
    }
    state.money += reward;
    state.phase = 'roundEnd';
    state.timer = 0;
    if (h.onMoneyChange) h.onMoneyChange(state.money);
    if (state.emit) state.emit('roundEnd', { winner, reason, reward });
    if (h.onRoundEnd) h.onRoundEnd(winner, reason);
    if (state.wins[winner] >= WIN_ROUNDS) {
      state.phase = 'matchEnd';
      if (h.onMatchEnd) h.onMatchEnd(winner);
    }
  }

  function step(dt) {
    if (dt <= 0) return;
    if (state.phase === 'buy') {
      state.timer -= dt;
      if (state.timer <= 0) {
        state.phase = 'live';
        state.timer = ROUND_TIME;
      }
    } else if (state.phase === 'live') {
      state.timer -= dt;
      if (state.timer <= 0) {
        state.timer = 0;
        endRound('ct', 'time');
      }
    }
  }

  return { step, startMatch, startRound, endRound, buy };
}
