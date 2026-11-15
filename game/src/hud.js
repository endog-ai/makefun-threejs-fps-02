// The DOM HUD for EMBERLINE. It never touches the simulation: main.js pushes
// numbers in and reads the play / buy callbacks out. Every setter caches its
// last value so the DOM is only written when something actually changed.
const OVERLAY_COPY = {
  start: {
    title: 'EMBERLINE',
    copy: 'Attackers plant the bomb at Turbine Hall or Coal Yard. Defenders hold the sites. First to 5 rounds takes the match.',
    action: 'Click to play',
  },
  paused: {
    title: 'EMBERLINE',
    copy: 'Paused. Click to resume.',
    action: 'Click to resume',
  },
  roundEnd: {
    title: 'Round over',
    copy: '',
    action: 'Next round',
  },
  matchEnd: {
    title: 'Match over',
    copy: '',
    action: 'Play again',
  },
};

export function createHud() {
  const el = (id) => document.getElementById(id);
  const overlay = el('overlay');
  const title = el('overlay-title');
  const copy = el('overlay-copy');
  const play = el('play');
  const ammo = el('ammo');
  const ammoMag = el('ammo-mag');
  const ammoReserve = el('ammo-reserve');
  const scoreValue = el('score-value');
  const healthValue = el('health');
  const moneyValue = el('money');
  const timerValue = el('timer');
  const roundValue = el('round');
  const weaponName = el('weapon-name');
  const bombStatus = el('bomb-status');
  const banner = el('banner');
  const bannerTitle = el('banner-title');
  const bannerSub = el('banner-sub');
  const buyMenu = el('buy-menu');
  const buyItems = el('buy-items');
  const buyMoney = el('buy-money');
  const killfeed = el('killfeed');
  const hitmarker = el('hitmarker');

  let hitTimer = 0;
  let lastMag = -1;
  let lastReserve = -1;
  let lastCt = -1;
  let lastT = -1;
  let lastHealth = -1;
  let lastMoney = -1;
  let lastTimer = -1;
  let lastRound = -1;
  let lastWeapon = '';
  let lastBomb = '';
  let buyOpen = false;
  let buyHandler = null;

  function hideBuyMenu() {
    if (!buyOpen) return;
    buyOpen = false;
    buyMenu.hidden = true;
    buyHandler = null;
  }

  // B / Esc closes the buy menu from the HUD side; main.js also sees the
  // same key through input.pressed and can close it during its own tick.
  window.addEventListener('keydown', (event) => {
    if (!buyOpen) return;
    if (event.code === 'Escape' || event.code === 'KeyB') hideBuyMenu();
  });

  return {
    setAmmo(mag, reserve) {
      if (mag === lastMag && reserve === lastReserve) return;
      lastMag = mag;
      lastReserve = reserve;
      ammoMag.textContent = String(mag);
      ammoReserve.textContent = `/ ${reserve}`;
      ammo.classList.toggle('empty', mag === 0);
    },
    setScore(ct, t) {
      if (ct === lastCt && t === lastT) return;
      lastCt = ct;
      lastT = t;
      scoreValue.textContent = `${ct} — ${t}`;
    },
    setHealth(hp) {
      const value = Math.max(0, Math.round(hp));
      if (value === lastHealth) return;
      lastHealth = value;
      healthValue.textContent = String(value);
      healthValue.classList.toggle('low', value <= 25);
    },
    setMoney(m) {
      const value = Math.round(m);
      if (value === lastMoney) return;
      lastMoney = value;
      moneyValue.textContent = `$${value}`;
    },
    setTimer(s) {
      const value = Math.max(0, Math.ceil(s));
      if (value === lastTimer) return;
      lastTimer = value;
      const mins = Math.floor(value / 60);
      const secs = String(value % 60).padStart(2, '0');
      timerValue.textContent = `${mins}:${secs}`;
      timerValue.classList.toggle('low', value <= 10);
    },
    setRound(n) {
      if (n === lastRound) return;
      lastRound = n;
      roundValue.textContent = `ROUND ${n}`;
    },
    setWeaponName(name) {
      if (name === lastWeapon) return;
      lastWeapon = name;
      weaponName.textContent = name;
    },
    setBomb(text) {
      if (text === lastBomb) return;
      lastBomb = text;
      bombStatus.textContent = text;
      bombStatus.classList.toggle('active', text.length > 0);
    },
    feed(text) {
      const line = document.createElement('div');
      line.className = 'feed-line';
      line.textContent = text;
      killfeed.prepend(line);
      while (killfeed.children.length > 5) killfeed.removeChild(killfeed.lastChild);
      setTimeout(() => line.remove(), 6000);
    },
    showBanner(bannerTitleText, sub) {
      bannerTitle.textContent = bannerTitleText;
      bannerSub.textContent = sub || '';
      banner.hidden = false;
    },
    hideBanner() {
      banner.hidden = true;
    },
    showBuyMenu(items, money, onBuy) {
      buyHandler = onBuy;
      buyMoney.textContent = `$${Math.round(money)}`;
      buyItems.textContent = '';
      for (const item of items) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'buy-row';
        const name = document.createElement('span');
        name.textContent = item.name;
        const price = document.createElement('span');
        price.className = 'buy-price';
        price.textContent = item.price === 0 ? 'OWNED' : `$${item.price}`;
        row.append(name, price);
        row.disabled = item.price > money;
        row.addEventListener('click', () => {
          if (buyHandler) buyHandler(item.id);
        });
        buyItems.appendChild(row);
      }
      buyMenu.hidden = false;
      buyOpen = true;
    },
    hideBuyMenu,
    showOverlay(mode, data) {
      const text = OVERLAY_COPY[mode] || OVERLAY_COPY.start;
      title.textContent = text.title;
      if (mode === 'roundEnd') {
        const winner = (data && data.winner) || '';
        const reason = (data && data.reason) || '';
        const score = data && data.score ? ` ${data.score.ct} — ${data.score.t}` : '';
        copy.textContent = `${winner} take the round.${reason ? ` ${reason}` : ''}${score}`;
      } else if (mode === 'matchEnd') {
        const winner = (data && data.winner) || '';
        const score = data && data.score ? ` Final score ${data.score.ct} — ${data.score.t}.` : '';
        copy.textContent = `${winner} win the match.${score}`;
      } else {
        copy.textContent = text.copy;
      }
      play.textContent = text.action;
      overlay.hidden = false;
      play.focus();
    },
    hideOverlay() {
      overlay.hidden = true;
    },
    onPlay(handler) {
      play.addEventListener('click', handler);
    },
    hitMarker(killed, holdMs = 90) {
      hitmarker.classList.add('on');
      hitmarker.classList.toggle('kill', killed);
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => {
        hitmarker.classList.remove('on');
        hitmarker.classList.remove('kill');
      }, holdMs);
    },
  };
}
