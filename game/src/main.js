// EMBERLINE — integration: wires the player, weapons, bots, rounds, bomb,
// Crucible and HUD into one fixed-step game loop, plus the deterministic
// ?shot=<name>&seed=1 staging the screenshots are taken from.
// One job per module; this file owns only the wiring between them:
// shooting raycast (headshot: 3x damage), grenade AoE, plant/defuse input,
// round flow, HUD sync, the buy menu, and the damage vignette.
//
// Round rules (coordinated here, not in any one module): attackers win by
// elimination or Molten Core detonation; defenders win by elimination, by
// defuse, or on the timer — except that a planted Core freezes the round
// timer (the round runs until detonation or defuse), and an elimination
// win for the defenders waits while a Core is planted so they can defuse.
import * as THREE from 'three';
import { PALETTE } from './palette.js';
import { createMap } from './map.js';
import { createPlayer } from './player.js';
import { createWeapon, WEAPONS, GRENADE, ARMOR } from './weapon.js';
import { createInput } from './input.js';
import { createHud } from './hud.js';
import { createAudio } from './audio.js';
import { createGameState } from './state.js';
import { createBots } from './bots.js';
import { createRounds, ROUND_TIME } from './rounds.js';
import { createBomb } from './bomb.js';
import { createCrucible } from './crucible.js';

const STEP = 1 / 60;
const ROUND_END_PAUSE = 4.5;
const T_SPAWN = 0;

// Seeded RNG for ?shot staging: with ?seed=1 every staged run plays the
// same sim, so a screenshot can be retaken and still match. Real play
// (no seed) keeps Math.random untouched.
const params = new URLSearchParams(location.search);
const shotName = params.get('shot');
const staging = shotName === 'start' || shotName === 'play' || shotName === 'plant' || shotName === 'buy';
if (staging && params.get('seed')) {
  let s = parseInt(params.get('seed'), 10) >>> 0 || 1;
  Math.random = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- renderer / scene -------------------------------------------------
const container = document.getElementById('game');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.canvas);
scene.fog = new THREE.Fog(new THREE.Color(PALETTE.canvas), 38, 85);
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 220);
camera.rotation.order = 'YXZ';
scene.add(camera);

const world = createMap(scene);
const state = createGameState();
const player = createPlayer(world.colliders);
const audio = staging
  ? { unlock() {}, shot() {}, reload() {}, hit() {}, kill() {}, dryfire() {}, plant() {}, beep() {}, explosion() {}, roundWin() {}, roundLose() {}, click() {}, footstep() {} }
  : createAudio();
const hud = createHud();

// ---- dynamic DOM: damage vignette, hint line, plant bar --------------
const vignette = document.createElement('div');
vignette.style.cssText = 'position:fixed;inset:0;pointer-events:none;opacity:0;background:radial-gradient(ellipse at center,transparent 52%,rgba(212,61,42,0.6) 100%)';
document.body.appendChild(vignette);

const hintEl = document.createElement('div');
hintEl.style.cssText = 'position:fixed;left:50%;bottom:96px;transform:translateX(-50%);font-family:ui-monospace,Menlo,monospace;font-size:13px;color:#f0a830;pointer-events:none;display:none';
document.body.appendChild(hintEl);

const plantBar = document.createElement('div');
plantBar.style.cssText = 'position:fixed;left:50%;top:58%;transform:translateX(-50%);width:220px;height:10px;border:1px solid #e9e6df;background:#14161a;display:none;pointer-events:none';
const plantFill = document.createElement('div');
plantFill.style.cssText = 'height:100%;width:0%;background:#f0a830';
plantBar.appendChild(plantFill);
document.body.appendChild(plantBar);

// Furnace glow: the planted/planting Molten Core ignites its site ring.
const glowLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 16);
scene.add(glowLight);
const glowRing = new THREE.Mesh(
  new THREE.RingGeometry(2.6, 3.2, 48),
  new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0, side: THREE.DoubleSide }),
);
glowRing.rotation.x = -Math.PI / 2;
scene.add(glowRing);

// Core detonation burst (own mesh; the grenade blast lives in weapon.js).
const detoMesh = new THREE.Mesh(
  new THREE.SphereGeometry(1, 20, 14),
  new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0, depthWrite: false }),
);
detoMesh.visible = false;
scene.add(detoMesh);
const detoLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 26);
scene.add(detoLight);
let detoAge = -1;
const detoPos = new THREE.Vector3();

// ---- match state owned here -------------------------------------------
let health = 100;
let playerAlive = true;
let owned = new Set(['pistol']);
let simTime = 0;
let roundEndAt = -100;
let prevPhase = state.phase;
let planting = false;
let plantingSite = null;
let vignetteFlash = 0;
let lastHint = '';
let hintUntil = 0;
let prevDefusing = false;
let lastBotShotAt = -100;
let lastGrenadeBlastAt = -100;
let prevFiring = false;
let wantShot = false;
let wantGrenade = false;
let stepAcc = 0;
const lastStepPos = new THREE.Vector3(-14, 0, 15);

const raycaster = new THREE.Raycaster();
const shootDir = new THREE.Vector3();
const tmpTarget = new THREE.Vector3();
let shotEvents = [];

// ---- hooks: bots -------------------------------------------------------
const botHooks = {
  damagePlayer: (dmg) => damagePlayer(dmg),
  damageBot: () => {}, // notification only: bots own their health, never re-apply
  onBotKilled: (bot, byPlayer) => {
    const n = Number(bot.id.slice(bot.team === 'ct' ? 3 : 2)) + 1;
    const name = bot.team === 'ct' ? `FOUNDRY-${n}` : `EMBER-${n}`;
    if (byPlayer) {
      const head = bot.lastHitPart === 'head';
      hud.feed(head ? `YOU ▸ ${name} — HEADSHOT` : `YOU ▸ ${name}`);
      state.emit('kill', { byPlayer: true, killerTeam: 't' });
      audio.kill();
    } else {
      hud.feed(`${name} is down`);
    }
  },
  onShot: (pos) => {
    shotEvents.push({ type: 'shot', pos });
    lastBotShotAt = simTime;
  },
};

// ---- hooks: weapon -----------------------------------------------------
const weaponHooks = {
  onShot: () => audio.shot(weapon.state.weaponId),
  onExplode: (pos, radius, damage) => grenadeExploded(pos, radius, damage),
};

function grenadeExploded(pos, radius, damage) {
  lastGrenadeBlastAt = simTime;
  audio.explosion();
  for (const bot of bots.list) {
    if (!bot.alive) continue;
    const d = Math.hypot(
      bot.group.position.x - pos.x,
      bot.group.position.y + 1.0 - pos.y,
      bot.group.position.z - pos.z,
    );
    if (d < radius) bots.damage(bot.torso, Math.round(damage * (1 - (d / radius) * 0.5)), 'torso');
  }
  if (playerAlive) {
    const d = Math.hypot(
      player.state.position.x - pos.x,
      player.state.position.y + 1.0 - pos.y,
      player.state.position.z - pos.z,
    );
    if (d < radius) damagePlayer(Math.round(damage * (1 - (d / radius) * 0.5)));
  }
}

// ---- hooks: bomb (Molten Core) -----------------------------------------
const bombHooks = {
  beep: (final) => audio.beep(final),
  onPlanted: (site) => {
    hud.feed(`MOLTEN CORE PLANTED AT ${world.sites[site].name.toUpperCase()}`);
    audio.plant();
  },
  onDefused: () => {
    hud.feed('MOLTEN CORE DEFUSED');
    rounds.endRound('ct', 'defused');
  },
  onExplode: (pos) => {
    audio.explosion();
    detoPos.copy(pos);
    detoAge = 0;
    rounds.endRound('t', 'detonation');
  },
};

// ---- hooks: rounds -----------------------------------------------------
const roundHooks = {
  onRoundStart: (n) => startRoundSetup(n),
  onRoundEnd: (winner, reason) => {
    const title = winner === 't' ? 'EMBER TAKE THE ROUND' : 'FOUNDRY TAKE THE ROUND';
    const reasonText = reason === 'elimination'
      ? 'All defenders eliminated'
      : reason === 'detonation'
        ? 'The Molten Core detonated'
        : reason === 'defused'
          ? 'The Molten Core was defused'
          : 'Time expired — defenders hold';
    hud.showBanner(title, reasonText);
    hud.feed(title);
    if (winner === 't') audio.roundWin();
    else audio.roundLose();
    roundEndAt = simTime;
    hud.hideBuyMenu();
  },
  onMatchEnd: (winner) => {
    hud.hideBuyMenu();
    hud.showOverlay('matchEnd', {
      winner: winner === 't' ? 'Ember' : 'Foundry',
      score: { ct: state.wins.ct, t: state.wins.t },
    });
  },
  onMoneyChange: (m) => hud.setMoney(m),
  onBuyResult: () => {},
};

const weapon = createWeapon(camera, scene, world, weaponHooks);
const bots = createBots(scene, world, botHooks, state);
const rounds = createRounds(state, state, roundHooks);
const bomb = createBomb(scene, world, state, bombHooks);
const crucible = createCrucible(scene, state);
const input = createInput(renderer.domElement, (locked) => {
  if (!locked && state.phase === 'live' && !isBuyOpen()) hud.showOverlay('paused');
  if (locked && (state.phase === 'live' || state.phase === 'buy')) hud.hideOverlay();
});

const shotTargets = [...bots.hitMeshes, ...world.shootables];

// ---- player damage -----------------------------------------------------
function damagePlayer(amount) {
  if (!playerAlive || state.phase !== 'live') return;
  let dmg = amount;
  if (player.state.armor > 0) dmg = Math.max(1, Math.round(dmg / 2));
  health -= dmg;
  vignetteFlash = 0.65;
  state.emit('damage', { amount: dmg });
  if (health <= 0) {
    health = 0;
    playerAlive = false;
    hud.feed('YOU ARE DOWN');
    hud.setHealth(0);
  }
}

// ---- shooting: raycast, headshot 3x, recoil + spread -------------------
function fireShot() {
  const def = weapon.def();
  if (!weapon.takeRound()) return;
  weapon.pullTrigger();
  player.recoil(0.012, (Math.random() - 0.5) * 0.006);
  camera.getWorldDirection(shootDir);
  const spread = weapon.spread(player.groundSpeed());
  shootDir.x += (Math.random() * 2 - 1) * spread;
  shootDir.y += (Math.random() * 2 - 1) * spread;
  shootDir.z += (Math.random() * 2 - 1) * spread;
  shootDir.normalize();
  raycaster.set(camera.position, shootDir);
  raycaster.far = 120;
  shotEvents.push({ type: 'shot', pos: player.state.position.clone() });
  const hits = raycaster.intersectObjects(shotTargets, false);
  if (!hits.length) return;
  const hit = hits[0];
  const bot = hit.object.userData ? hit.object.userData.bot : null;
  if (!bot) return; // wall hit: the shot stops, no marker
  const part = hit.object.userData.part || 'torso';
  const dmg = def.damage * (part === 'head' ? def.headMul : 1);
  const killed = bots.damage(hit.object, dmg, part);
  hud.hitMarker(killed, killed ? 300 : 90);
  if (!killed) audio.hit();
}

function handleFiring() {
  if (state.phase !== 'live' || !playerAlive) {
    prevFiring = input.state.firing || wantShot;
    wantShot = false;
    return;
  }
  const staged = wantShot;
  const firing = input.state.firing || staged;
  wantShot = false;
  const def = weapon.def();
  // A staged trigger pulse counts as a fresh press each tick it is set,
  // so the semi-auto pistol fires once per pulse instead of once per hold.
  const rising = (firing && !prevFiring) || staged;
  if (firing && weapon.ready() && (def.auto || rising)) {
    fireShot();
  } else if (rising && weapon.state.mag === 0 && weapon.state.reloadLeft === 0) {
    audio.dryfire();
    showHint('MAG EMPTY — PRESS R', 1.2);
  }
  prevFiring = firing;
}

// ---- one-shot keys: reload, weapon switch, grenade, buy menu ----------
function handlePressedKeys() {
  const pressed = input.state.pressed;
  if (state.phase === 'live' && playerAlive) {
    if (pressed.has('KeyR')) {
      const def = weapon.def();
      if (weapon.state.reloadLeft === 0 && weapon.state.mag < def.mag && weapon.state.reserve > 0) {
        weapon.reload();
        audio.reload();
      }
    }
    const switchTo = pressed.has('Digit1') ? 'pistol' : pressed.has('Digit2') ? 'smg' : pressed.has('Digit3') ? 'rifle' : null;
    if (switchTo && owned.has(switchTo) && switchTo !== weapon.state.weaponId) {
      weapon.setWeapon(switchTo);
      audio.click();
    }
    if (pressed.has('KeyG') && weapon.state.grenades > 0) {
      camera.getWorldDirection(shootDir);
      tmpTarget.copy(camera.position).addScaledVector(shootDir, 0.6);
      tmpTarget.y -= 0.1;
      if (weapon.throwGrenade(tmpTarget, shootDir)) audio.click();
    }
  }
  if (pressed.has('KeyB') && state.phase === 'buy') {
    // The HUD's own keydown handler closes an open menu on B; this tick
    // only opens one that was already closed when B went down.
    if (!lastBMenuWasOpen && !isBuyOpen()) openBuyMenu();
  }
}

// The HUD closes an open buy menu on B/Escape in its own keydown
// listener, which runs before this tick sees the press; record whether
// the menu was open at keydown time so the tick does not re-open it.
let lastBMenuWasOpen = false;
window.addEventListener('keydown', (event) => {
  if (event.code === 'KeyB') lastBMenuWasOpen = isBuyOpen();
}, true);

function isBuyOpen() {
  const menu = document.getElementById('buy-menu');
  return !!menu && !menu.hidden;
}

function buyItems() {
  return [
    { id: 'pistol', name: 'P9 Sidearm', price: 0 },
    { id: 'smg', name: 'Hornet-9 SMG', price: owned.has('smg') ? 0 : WEAPONS.smg.price },
    { id: 'rifle', name: 'VK-7 Carbine', price: owned.has('rifle') ? 0 : WEAPONS.rifle.price },
    { id: 'grenade', name: 'Frag Grenade', price: GRENADE.price },
    { id: 'armor', name: 'Kevlar Vest', price: ARMOR.price },
  ];
}

function openBuyMenu() {
  if (state.phase !== 'buy') return;
  hud.showBuyMenu(buyItems(), state.money, onBuy);
  // The round-end banner sits under the buy panel (both are fixed and the
  // panel paints later); lift it above the panel while shopping so the
  // round result stays readable, and put it back when play resumes.
  const bannerEl = document.getElementById('banner');
  if (bannerEl && !bannerEl.hidden) {
    bannerEl.style.top = '9%';
    bannerEl.style.zIndex = '10';
  }
  if (document.pointerLockElement) document.exitPointerLock();
}

function refreshBuyMenu() {
  if (isBuyOpen()) hud.showBuyMenu(buyItems(), state.money, onBuy);
}

function onBuy(id) {
  // Re-selecting an owned weapon just switches to it, free.
  if (WEAPONS[id] && owned.has(id)) {
    weapon.setWeapon(id);
    audio.click();
    hud.setWeaponName(weapon.def().name);
    hud.setAmmo(weapon.state.mag, weapon.state.reserve);
    refreshBuyMenu();
    return;
  }
  if (!rounds.buy(id)) return;
  audio.click();
  if (WEAPONS[id]) {
    owned.add(id);
    weapon.setWeapon(id);
  } else if (id === GRENADE.id) {
    weapon.state.grenades += 1;
  } else if (id === ARMOR.id) {
    player.state.armor = 1;
  }
  hud.setWeaponName(weapon.def().name);
  hud.setAmmo(weapon.state.mag, weapon.state.reserve);
  refreshBuyMenu();
}

// ---- Molten Core: hold E inside a site to plant ------------------------
function handlePlant() {
  if (state.phase !== 'live' || !playerAlive || bomb.status !== 'carried') {
    if (planting) {
      bomb.cancelPlant();
      planting = false;
    }
    return;
  }
  const p = player.state.position;
  let site = null;
  for (const key of ['A', 'B']) {
    const s = world.sites[key];
    const dx = p.x - s.center.x;
    const dz = p.z - s.center.z;
    if (dx * dx + dz * dz < s.radius * s.radius) {
      site = key;
      break;
    }
  }
  if (input.state.keys.has('KeyE') && site) {
    if (!planting && bomb.startPlant(site)) {
      planting = true;
      plantingSite = site;
      audio.plant();
    }
  } else if (planting) {
    bomb.cancelPlant();
    planting = false;
  }
}

function attackerNearSite(center) {
  const R = 8;
  if (playerAlive) {
    const dx = player.state.position.x - center.x;
    const dz = player.state.position.z - center.z;
    if (dx * dx + dz * dz < R * R) return true;
  }
  for (const bot of bots.list) {
    if (bot.team !== 't' || !bot.alive) continue;
    const dx = bot.group.position.x - center.x;
    const dz = bot.group.position.z - center.z;
    if (dx * dx + dz * dz < R * R) return true;
  }
  return false;
}

// ---- round setup / round-end checks ------------------------------------
function startRoundSetup(n) {
  bots.reset(n);
  bomb.reset();
  planting = false;
  plantingSite = null;
  playerAlive = true;
  health = 100;
  player.state.armor = 0;
  player.state.velocity.set(0, 0, 0);
  const spawn = world.spawns.t[T_SPAWN];
  player.state.position.set(spawn.x, 0, spawn.z);
  player.state.yaw = 0;
  player.state.pitch = 0;
  lastStepPos.set(spawn.x, 0, spawn.z);
  if (n === 1) {
    owned = new Set(['pistol']);
    weapon.setWeapon('pistol');
    weapon.refill();
    weapon.state.grenades = 0;
    crucible.reset();
  }
  hud.setRound(n);
  hud.setHealth(100);
  hud.setWeaponName(weapon.def().name);
  hud.setAmmo(weapon.state.mag, weapon.state.reserve);
  hud.setMoney(state.money);
  hud.setBomb('');
  if (!staging || shotName === 'buy') openBuyMenu();
}

function checkRoundEnd() {
  if (state.phase !== 'live') return;
  // Defenders cannot win by elimination while a Core is planted: they
  // still have to defuse it (or let it detonate).
  if (bomb.status !== 'planted' && !playerAlive && bots.aliveCount('t') === 0) {
    rounds.endRound('ct', 'elimination');
    return;
  }
  if (bots.aliveCount('ct') === 0) rounds.endRound('t', 'elimination');
}

// ---- HUD sync, hints, vignette, furnace glow ---------------------------
function showHint(text, seconds) {
  hintEl.textContent = text;
  hintEl.style.display = 'block';
  lastHint = text;
  hintUntil = simTime + seconds;
}

function syncHud() {
  hud.setHealth(health);
  hud.setAmmo(weapon.state.mag, weapon.state.reserve);
  hud.setMoney(state.money);
  hud.setTimer(bomb.status === 'planted' ? bomb.timer : state.timer);
  hud.setRound(Math.max(1, state.round));
  hud.setScore(state.wins.ct, state.wins.t);
  hud.setWeaponName(weapon.def().name);
  if (planting) {
    hud.setBomb(`PLANTING MOLTEN CORE ${Math.round(bomb.plantProgress * 100)}%`);
  } else if (bomb.status === 'planted') {
    const defusing = bots.list.some((b) => b.alive && b.defusing);
    hud.setBomb(defusing
      ? `DEFUSING THE MOLTEN CORE ${Math.round(bomb.defuseProgress * 100)}%`
      : `MOLTEN CORE PLANTED — ${Math.ceil(bomb.timer)}s`);
  } else {
    hud.setBomb('');
  }

  // Hint line: reload beats empty mag beats buy-phase reminder.
  let hint = '';
  if (state.phase === 'live' && playerAlive) {
    if (weapon.state.reloadLeft > 0) hint = 'RELOADING…';
    else if (weapon.state.mag === 0) hint = 'MAG EMPTY — PRESS R';
    else if (weapon.state.mag <= 6) hint = 'LOW AMMO — PRESS R TO RELOAD';
  } else if (state.phase === 'buy' && !isBuyOpen()) {
    hint = 'BUY PHASE — PRESS B FOR EQUIPMENT';
  }
  if (hint) {
    if (hint !== lastHint) {
      hintEl.textContent = hint;
      hintEl.style.display = 'block';
      lastHint = hint;
    }
  } else if (simTime >= hintUntil) {
    hintEl.style.display = 'none';
    lastHint = '';
  }

  // Plant progress bar under the crosshair.
  if (planting) {
    plantBar.style.display = 'block';
    plantFill.style.width = `${Math.round(bomb.plantProgress * 100)}%`;
  } else {
    plantBar.style.display = 'none';
  }

  // Damage vignette: flash on hurt, slow pulse at low health.
  vignetteFlash = Math.max(0, vignetteFlash - 0.016);
  const lowPulse = playerAlive && health <= 25 ? 0.16 + 0.06 * Math.sin(simTime * 5) : 0;
  vignette.style.opacity = String(Math.max(vignetteFlash, lowPulse));

  // Furnace glow at the planting / planted site.
  const glowSite = planting ? plantingSite : bomb.status === 'planted' ? bomb.site : null;
  if (glowSite) {
    const c = world.sites[glowSite].center;
    glowLight.position.set(c.x, 1.8, c.z);
    glowRing.position.set(c.x, 0.06, c.z);
    const pulse = 0.6 + 0.4 * Math.sin(simTime * 6);
    glowLight.intensity = planting ? 15 + 45 * bomb.plantProgress : 45 * pulse + 15;
    glowRing.material.opacity = planting ? 0.25 + 0.5 * bomb.plantProgress : 0.55 * pulse + 0.2;
  } else {
    glowLight.intensity = 0;
    glowRing.material.opacity = 0;
  }
}

function updateCamera() {
  if (state.phase === 'menu') {
    // Yard vista for the menu: Crucible mid-ground, both sites beyond.
    camera.position.set(-16, 4.5, 16.5);
    camera.lookAt(0, 0.5, -8);
    return;
  }
  camera.position.set(
    player.state.position.x,
    player.state.position.y + player.state.eye,
    player.state.position.z,
  );
  camera.rotation.y = player.state.yaw;
  camera.rotation.x = player.state.pitch;
  camera.updateMatrixWorld();
}

// ---- ?shot staging -----------------------------------------------------
// Every staged frame is the real game simulated forward with scripted
// inputs (aim, trigger pulses, E held, grenade thrown) — never composited.
// When a shot's predicate holds, the sim freezes on that exact frame
// (stagingHold) so the screenshot catches even 60 ms effects (muzzle
// flash, hitmarker, tracer, grenade blast) exactly as rendered.
let stageVictim = null;
const stage = { name: shotName, phase: 'init', t0: 0, attempts: 0, ready: false, done: false };
let stagingHold = false;
let frames = 0;

const wallPoint = new THREE.Vector3(-11, 1.5, 10);
const midPoint = new THREE.Vector3(0, 1.2, -2);

function aimAt(target, pitchBias = 0) {
  const dx = target.x - player.state.position.x;
  const dy = target.y - (player.state.position.y + player.state.eye);
  const dz = target.z - player.state.position.z;
  const dist = Math.hypot(dx, dy, dz) || 1;
  player.state.yaw = Math.atan2(-dx, -dz);
  player.state.pitch = Math.max(-1.45, Math.min(1.45,
    Math.asin(Math.max(-1, Math.min(1, dy / dist))) + pitchBias));
}

function nearestCtBot() {
  let best = null;
  let bestD = Infinity;
  for (const bot of bots.list) {
    if (bot.team !== 'ct' || !bot.alive) continue;
    const dx = bot.group.position.x - player.state.position.x;
    const dz = bot.group.position.z - player.state.position.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) {
      bestD = d;
      best = bot;
    }
  }
  return best;
}

function botHead(bot) {
  return tmpTarget.set(bot.group.position.x, bot.group.position.y + 1.53, bot.group.position.z);
}

function skipBuyPhase() {
  if (state.phase === 'buy') {
    state.phase = 'live';
    state.timer = ROUND_TIME;
    hud.hideBuyMenu();
    hud.hideBanner();
  }
}

function stageSetupPlay() {
  stage.t0 = simTime;
  stage.attempts += 1;
  stage.ready = false; // a ready set in a dying attempt must not leak here
  stageVictim = null;
  rounds.startMatch();
  hud.hideOverlay(); // staging has no Play click; the menu overlay must go
  onBuy('grenade'); // real economy: a $300 frag from the $800 start
  skipBuyPhase();
  player.state.position.set(0, 0, 8);
  player.state.velocity.set(0, 0, 0);
  player.state.yaw = 0;
  player.state.pitch = 0;
  stage.phase = 'hunt';
}

function stageSetupPlant() {
  stage.t0 = simTime;
  stage.attempts += 1;
  stage.ready = false; // a ready set in a dying attempt must not leak here
  rounds.startMatch();
  hud.hideOverlay(); // staging has no Play click; the menu overlay must go
  skipBuyPhase();
  player.state.position.set(-15, 0, -11);
  player.state.velocity.set(0, 0, 0);
  player.state.yaw = 0;
  player.state.pitch = 0;
  input.state.keys.add('KeyE'); // hold E: the real plant input path
  stage.phase = 'planting';
}

function stageSetupBuy() {
  stage.t0 = simTime;
  stage.attempts += 1;
  stage.ready = false; // a ready set in a dying attempt must not leak here
  rounds.startMatch();
  hud.hideOverlay(); // staging has no Play click; the menu overlay must go
  skipBuyPhase();
  player.state.position.set(-14, 0, 15);
  player.state.velocity.set(0, 0, 0);
  stage.phase = 'burn';
}

function stageTick() {
  if (!staging || stage.done) return;
  if (shotName === 'start') return;
  const elapsed = simTime - stage.t0;

  // Death during a combat shot: retake the shot (max 3 attempts), then
  // accept the best frame we have rather than nothing.
  if (!playerAlive) {
    input.state.keys.delete('KeyE');
    if (stage.attempts < 3) {
      if (shotName === 'play') stageSetupPlay();
      else if (shotName === 'plant') stageSetupPlant();
      else if (shotName === 'buy') stageSetupBuy();
    } else {
      stage.ready = true;
    }
    return;
  }

  if (shotName === 'play') {
    // The victim is the defender wounded in 'hunt' (one pistol headshot
    // leaves it at 22 hp); the final round finishes it, so the HEADSHOT
    // killfeed is fresh in the frozen frame instead of expired.
    const bot = stageVictim && stageVictim.alive ? stageVictim : nearestCtBot();
    if (stage.phase === 'hunt') {
      const target = nearestCtBot();
      if (!target) {
        stage.phase = 'burn';
        return;
      }
      stageVictim = target;
      aimAt(botHead(target));
      if (weapon.ready() && weapon.state.mag === 12) wantShot = true;
      if (weapon.state.mag < 12) stage.phase = 'burn';
      else if (elapsed > 20) stage.phase = 'burn';
    } else if (stage.phase === 'burn') {
      aimAt(wallPoint);
      if (weapon.state.mag > 1 && weapon.ready()) wantShot = true;
      else if (weapon.state.mag <= 1) stage.phase = 'throw';
      if (elapsed > 25) stage.phase = 'throw';
    } else if (stage.phase === 'throw') {
      if (weapon.state.grenades > 0) {
        aimAt(midPoint);
        wantGrenade = true;
      }
      stage.phase = 'wait-blast';
    } else if (stage.phase === 'wait-blast') {
      if (bot) aimAt(botHead(bot));
      // The grenade fuse is 1.6 s and the blast shows for 0.45 s: fire
      // the last round inside that window so blast, muzzle flash, and
      // the headshot kill all land in the same frozen frame.
      const blastRecent = lastGrenadeBlastAt > 0 && simTime - lastGrenadeBlastAt < 0.4;
      if (blastRecent && weapon.state.mag > 0 && weapon.ready()) wantShot = true;
      if (weapon.state.mag === 0) stage.phase = 'final';
      else if (elapsed > 30) stage.phase = 'final';
    } else if (stage.phase === 'final') {
      if (bot) aimAt(botHead(bot));
      if (weapon.state.mag > 0 && weapon.ready()) wantShot = true;
      if (weapon.state.mag === 0) stage.ready = true;
      else if (elapsed > 35) stage.ready = true;
    }
  } else if (shotName === 'plant') {
    const bot = nearestCtBot();
    if (bot) aimAt(botHead(bot), -0.18); // bot in frame, site ring at feet
    if (bomb.plantProgress >= 0.5 && bomb.plantProgress < 0.85 && bot) {
      stage.ready = true;
    } else if (bomb.status === 'planted' || elapsed > 15) {
      input.state.keys.delete('KeyE');
      if (stage.attempts < 3 && bomb.status !== 'planted') stageSetupPlant();
      else stage.ready = true;
    }
  } else if (shotName === 'buy') {
    if (stage.phase === 'burn') {
      aimAt(wallPoint);
      if (weapon.state.mag > 0 && weapon.ready()) wantShot = true;
      if (weapon.state.mag === 0) stage.phase = 'clear';
      else if (elapsed > 12) stage.phase = 'clear';
    } else if (stage.phase === 'clear') {
      for (const bot of bots.list) {
        if (bot.team === 'ct' && bot.alive) bots.damage(bot.torso, 999, 'torso');
      }
      stage.phase = 'wait-buy';
    } else if (stage.phase === 'wait-buy') {
      if (state.phase === 'buy' && isBuyOpen() && weapon.state.mag === 0) stage.ready = true;
      else if (elapsed > 25) stage.ready = true;
    }
  }
}

function stageCheck() {
  if (!staging || stage.done) return;
  if (shotName === 'start') {
    if (frames >= 2) {
      stage.done = true;
      window.__shotReady = true;
    }
    return;
  }
  if (stage.ready) {
    stagingHold = true;
    stage.done = true;
    window.__shotReady = true;
  }
}

// ---- fixed-step simulation ---------------------------------------------
function stepSim(dt) {
  simTime += dt;
  if (staging) stageTick();
  const look = input.takeLook();
  if (input.state.locked || staging) player.look(look.x, look.y);
  updateCamera();

  if (state.phase === 'menu' || state.phase === 'matchEnd') {
    crucible.step(dt);
  } else if (state.phase === 'roundEnd') {
    crucible.step(dt);
    if (simTime - roundEndAt >= ROUND_END_PAUSE) rounds.startRound(state.round + 1);
  } else {
    // 'buy' or 'live'
    if (state.phase === 'live') {
      player.step(dt, input.state.keys);
      handlePressedKeys();
      handleFiring();
      if (wantGrenade) {
        wantGrenade = false;
        if (playerAlive && weapon.state.grenades > 0) {
          camera.getWorldDirection(shootDir);
          tmpTarget.copy(camera.position).addScaledVector(shootDir, 0.6);
          tmpTarget.y -= 0.1;
          if (weapon.throwGrenade(tmpTarget, shootDir)) audio.click();
        }
      }
      handlePlant();
    } else {
      player.step(dt, input.state.keys);
      handlePressedKeys();
    }
    weapon.step(dt);
    crucible.step(dt);

    // Crucible vent damage: 10/s inside radius 4 m while venting.
    if (state.phase === 'live' && crucible.active && playerAlive) {
      const dx = player.state.position.x - crucible.center.x;
      const dz = player.state.position.z - crucible.center.z;
      if (dx * dx + dz * dz < crucible.radius * crucible.radius) {
        damagePlayer(crucible.damagePerSecond * dt);
      }
    }

    // Shots heard this tick (player fire + bot fire) reach the bots as
    // events; the vent reaches them live through ctx.vent and the bus.
    const eventsThisTick = shotEvents;
    shotEvents = [];
    const ctx = {
      playerPos: player.state.position,
      playerAlive,
      playerSpeed: player.groundSpeed(),
      bombPlanted: bomb.status === 'planted',
      bombSite: bomb.site,
      bombPos: bomb.position,
      bomb: { planted: bomb.status === 'planted', site: bomb.site, pos: bomb.position },
      vent: crucible.ventState(),
      events: eventsThisTick,
    };
    if (state.phase === 'live') bots.step(dt, simTime, ctx);

    let defusingBot = false;
    for (const bot of bots.list) {
      if (bot.alive && bot.defusing) {
        defusingBot = true;
        break;
      }
    }
    if (defusingBot && !prevDefusing) hud.feed('FOUNDRY IS DEFUSING THE MOLTEN CORE');
    prevDefusing = defusingBot;
    const siteCenter = bomb.site ? world.sites[bomb.site].center : null;
    bomb.step(dt, {
      defusing: defusingBot,
      attackerNearSite: bomb.status === 'planted' && siteCenter ? attackerNearSite(siteCenter) : false,
    });

    // A planted Core freezes the round timer: the round runs until
    // detonation or defuse, never a timeout win for the defenders.
    if (bomb.status === 'planted' && state.timer < 36) state.timer = 36;
    rounds.step(dt);
    if (state.phase === 'live') checkRoundEnd();

    const moved = Math.hypot(player.state.position.x - lastStepPos.x, player.state.position.z - lastStepPos.z);
    stepAcc += moved;
    lastStepPos.set(player.state.position.x, 0, player.state.position.z);
    if (stepAcc > 2.4 && player.groundSpeed() > 1 && player.state.onGround) {
      stepAcc = 0;
      audio.footstep();
    }

    if (detoAge >= 0) {
      detoAge += dt;
      const t = detoAge / 0.6;
      if (t >= 1) {
        detoMesh.visible = false;
        detoLight.intensity = 0;
        detoAge = -1;
      } else {
        detoMesh.visible = true;
        detoMesh.position.copy(detoPos);
        const s = 0.5 + t * 9;
        detoMesh.scale.set(s, s, s);
        detoMesh.material.opacity = 0.9 * (1 - t);
        detoLight.position.copy(detoPos);
        detoLight.position.y += 1;
        detoLight.intensity = 120 * (1 - t);
      }
    }
  }

  if (prevPhase !== state.phase) {
    if (state.phase === 'live') {
      if (isBuyOpen()) hud.hideBuyMenu();
      hud.hideBanner();
      const bannerEl = document.getElementById('banner');
      if (bannerEl) {
        bannerEl.style.top = '';
        bannerEl.style.zIndex = '';
      }
      if (!input.state.locked && !staging) hud.showOverlay('paused');
    }
    prevPhase = state.phase;
  }
  syncHud();
  input.clearPressed();
}

// ---- render loop --------------------------------------------------------
let last = performance.now();
let acc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  if (!stagingHold) {
    acc += dt;
    let n = 0;
    while (acc >= STEP && n < 6) {
      stepSim(STEP);
      acc -= STEP;
      n += 1;
    }
    if (n === 6) acc = 0;
  }
  renderer.render(scene, camera);
  frames += 1;
  if (staging) stageCheck();
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function requestLockSafe() {
  try {
    const p = input.requestLock();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (err) { /* pointer lock unavailable; the game still plays */ }
}

renderer.domElement.addEventListener('click', () => {
  audio.unlock();
  if ((state.phase === 'live' || state.phase === 'buy') && !input.state.locked && !isBuyOpen()) {
    requestLockSafe();
  }
});

hud.onPlay(() => {
  audio.unlock();
  if (state.phase === 'menu' || state.phase === 'matchEnd') {
    hud.hideOverlay();
    rounds.startMatch();
  } else {
    hud.hideOverlay();
    requestLockSafe();
  }
});

// ---- init ---------------------------------------------------------------
bots.reset(1);
bomb.reset();
weapon.setWeapon('pistol');
weapon.refill();
hud.setHealth(100);
hud.setAmmo(WEAPONS.pistol.mag, WEAPONS.pistol.reserve);
hud.setMoney(state.money);
hud.setTimer(ROUND_TIME);
hud.setRound(1);
hud.setScore(0, 0);
hud.setWeaponName(WEAPONS.pistol.name);
hud.setBomb('');
hud.showOverlay('start');

if (staging) {
  if (shotName === 'start') {
    crucible.setVent(true);
    stage.phase = 'start';
  } else if (shotName === 'play') stageSetupPlay();
  else if (shotName === 'plant') stageSetupPlant();
  else if (shotName === 'buy') stageSetupBuy();
}

window.__ember = { state, bots, weapon, player, bomb, rounds, crucible, hud, input, world, camera, renderer, stage, get simTime() { return simTime; } };
window.__shotReady = false;
requestAnimationFrame(frame);
