// Weapons for EMBERLINE: the weapon table, a first-person view model that is
// restyled per weapon, and a thrown-frag simulation. This module owns the
// numbers (damage, spread, fire rate, reload); main.js owns the raycast and
// applies the damage. Grenades fly, bounce off world colliders and explode
// on a 1.6 s fuse through hooks.onExplode.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

export const WEAPONS = {
  pistol: { id: 'pistol', name: 'P9 Sidearm', price: 0, mag: 12, reserve: 36, gap: 0.16, reload: 1.4, damage: 26, headMul: 3, spreadStill: 0.003, spreadMove: 0.02, auto: false },
  smg: { id: 'smg', name: 'Hornet-9', price: 1500, mag: 32, reserve: 96, gap: 0.065, reload: 1.8, damage: 22, headMul: 3, spreadStill: 0.004, spreadMove: 0.032, auto: true },
  rifle: { id: 'rifle', name: 'VK-7 Carbine', price: 2700, mag: 30, reserve: 90, gap: 0.096, reload: 1.9, damage: 34, headMul: 3, spreadStill: 0.0022, spreadMove: 0.028, auto: true },
};
export const GRENADE = { id: 'grenade', name: 'Frag Grenade', price: 300, max: 2 };
export const ARMOR = { id: 'armor', name: 'Kevlar Vest', price: 650 };

const MOVE_REFERENCE = 5.2;
const FLASH_TIME = 0.06;
const GRENADE_FUSE = 1.6;
const GRENADE_RADIUS = 4.5;
const GRENADE_DAMAGE = 110;
const GRENADE_GRAVITY = 18;
const GRENADE_THROW_SPEED = 13;
const GRENADE_THROW_UP = 4.5;
const BOUNCE_KEEP = 0.45;
const GRENADE_R = 0.09;

// Per-weapon view-model look: barrel length, body tint and grip position.
// One group is built once and restyled here, never rebuilt per frame.
const VIEW_STYLE = {
  pistol: { barrelLen: 0.16, barrelZ: -0.26, body: 'ink', grip: 'hairline', modelZ: -0.36, modelY: -0.22 },
  smg: { barrelLen: 0.3, barrelZ: -0.34, body: 'sand', grip: 'hairline', modelZ: -0.4, modelY: -0.21 },
  rifle: { barrelLen: 0.42, barrelZ: -0.4, body: 'ink', grip: 'rust', modelZ: -0.44, modelY: -0.2 },
};

export function createWeapon(camera, scene, world, hooks) {
  const safeHooks = hooks || {};
  const colliders = (world && world.colliders) || [];

  const darkMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.7, metalness: 0.2 });
  const bodyMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ink), roughness: 0.5, metalness: 0.35 });
  const accentMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.accent), roughness: 0.5, metalness: 0.3 });

  const model = new THREE.Group();
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.42), bodyMat);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.045, 0.42), darkMat);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.08, 0.22), darkMat);
  const sight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, 0.08), accentMat);
  sight.position.set(0, 0.07, -0.08);
  stock.position.set(0, -0.02, 0.3);
  model.add(receiver, barrel, stock, sight);
  model.position.set(0.24, -0.2, -0.44);
  camera.add(model);

  const flash = new THREE.Mesh(
    new THREE.PlaneGeometry(0.24, 0.24),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }),
  );
  flash.position.set(0.24, -0.18, -0.95);
  flash.visible = false;
  camera.add(flash);

  const flashLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 5);
  flashLight.position.set(0.24, -0.16, -0.6);
  camera.add(flashLight);

  // One reusable explosion visual: a sphere that swells and fades, plus light.
  const blast = new THREE.Mesh(
    new THREE.SphereGeometry(1, 16, 12),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0, depthWrite: false }),
  );
  blast.visible = false;
  scene.add(blast);
  const blastLight = new THREE.PointLight(new THREE.Color(PALETTE.accent), 0, 12);
  scene.add(blastLight);
  let blastAge = -1;

  const grenadeMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.rust), roughness: 0.6, metalness: 0.4 });
  const grenadeGeo = new THREE.SphereGeometry(GRENADE_R, 10, 8);
  const active = [];
  const tmpPos = new THREE.Vector3();
  const tmpVel = new THREE.Vector3();

  const state = {
    mag: WEAPONS.rifle.mag,
    reserve: WEAPONS.rifle.reserve,
    cooldown: 0,
    reloadLeft: 0,
    flash: 0,
    kick: 0,
    weaponId: 'rifle',
    grenades: 0,
  };

  function def() {
    return WEAPONS[state.weaponId];
  }

  function applyStyle() {
    const style = VIEW_STYLE[state.weaponId];
    barrel.scale.z = style.barrelLen / 0.42;
    barrel.position.set(0, 0.025, style.barrelZ);
    bodyMat.color.set(PALETTE[style.body]);
    darkMat.color.set(PALETTE[style.grip]);
    model.position.set(0.24, style.modelY, style.modelZ);
    flash.position.set(0.24, style.modelY + 0.02, style.modelZ - 0.51);
    flashLight.position.set(0.24, style.modelY + 0.04, style.modelZ - 0.16);
  }

  function setWeapon(id) {
    if (!WEAPONS[id] || id === state.weaponId) return;
    state.weaponId = id;
    const d = WEAPONS[id];
    state.mag = d.mag;
    state.reserve = d.reserve;
    state.cooldown = 0;
    state.reloadLeft = 0;
    state.flash = 0;
    state.kick = 0;
    applyStyle();
  }

  function explode(g) {
    blast.position.copy(g.pos);
    blast.visible = true;
    blastAge = 0;
    blastLight.position.copy(g.pos);
    blastLight.intensity = 60;
    if (safeHooks.onExplode) safeHooks.onExplode(g.pos.clone(), GRENADE_RADIUS, GRENADE_DAMAGE);
  }

  // Point-vs-box bounce: move, then push out along the shallowest
  // penetration axis and reflect that velocity component, damped.
  function bounceGrenade(g, dt) {
    tmpVel.copy(g.vel);
    tmpPos.copy(g.pos).addScaledVector(tmpVel, dt);
    g.vel.y -= GRENADE_GRAVITY * dt;
    for (let i = 0; i < colliders.length; i++) {
      const box = colliders[i];
      if (tmpPos.x < box.min.x - GRENADE_R || tmpPos.x > box.max.x + GRENADE_R
        || tmpPos.y < box.min.y - GRENADE_R || tmpPos.y > box.max.y + GRENADE_R
        || tmpPos.z < box.min.z - GRENADE_R || tmpPos.z > box.max.z + GRENADE_R) continue;
      const dxMin = tmpPos.x - (box.min.x - GRENADE_R);
      const dxMax = (box.max.x + GRENADE_R) - tmpPos.x;
      const dyMin = tmpPos.y - (box.min.y - GRENADE_R);
      const dyMax = (box.max.y + GRENADE_R) - tmpPos.y;
      const dzMin = tmpPos.z - (box.min.z - GRENADE_R);
      const dzMax = (box.max.z + GRENADE_R) - tmpPos.z;
      const minPen = Math.min(dxMin, dxMax, dyMin, dyMax, dzMin, dzMax);
      if (minPen === dxMin) { tmpPos.x = box.min.x - GRENADE_R; g.vel.x = -Math.abs(g.vel.x) * BOUNCE_KEEP; }
      else if (minPen === dxMax) { tmpPos.x = box.max.x + GRENADE_R; g.vel.x = Math.abs(g.vel.x) * BOUNCE_KEEP; }
      else if (minPen === dyMin) { tmpPos.y = box.min.y - GRENADE_R; g.vel.y = -Math.abs(g.vel.y) * BOUNCE_KEEP; }
      else if (minPen === dyMax) { tmpPos.y = box.max.y + GRENADE_R; g.vel.y = Math.abs(g.vel.y) * BOUNCE_KEEP; }
      else if (minPen === dzMin) { tmpPos.z = box.min.z - GRENADE_R; g.vel.z = -Math.abs(g.vel.z) * BOUNCE_KEEP; }
      else { tmpPos.z = box.max.z + GRENADE_R; g.vel.z = Math.abs(g.vel.z) * BOUNCE_KEEP; }
    }
    if (tmpPos.y < GRENADE_R) {
      tmpPos.y = GRENADE_R;
      g.vel.y = Math.abs(g.vel.y) * BOUNCE_KEEP;
      g.vel.x *= 0.8;
      g.vel.z *= 0.8;
    }
    g.pos.copy(tmpPos);
    g.mesh.position.copy(g.pos);
  }

  function step(dt) {
    state.cooldown = Math.max(0, state.cooldown - dt);
    state.flash = Math.max(0, state.flash - dt);
    state.kick += (0 - state.kick) * Math.min(1, dt * 14);
    model.position.z = VIEW_STYLE[state.weaponId].modelZ + state.kick;
    model.rotation.x = state.kick * 2.2;
    flash.visible = state.flash > 0;
    if (state.flash > 0) flash.rotation.z = state.flash * 30;
    flashLight.intensity = state.flash > 0 ? 18 : 0;
    if (state.reloadLeft > 0) {
      state.reloadLeft = Math.max(0, state.reloadLeft - dt);
      const d = def();
      model.rotation.x = -0.55 * Math.min(1, (d.reload - state.reloadLeft) * 2);
      if (state.reloadLeft === 0) {
        const need = d.mag - state.mag;
        const take = Math.min(need, state.reserve);
        state.mag += take;
        state.reserve -= take;
      }
    }
    if (blastAge >= 0) {
      blastAge += dt;
      const t = blastAge / 0.45;
      if (t >= 1) {
        blast.visible = false;
        blastLight.intensity = 0;
        blastAge = -1;
      } else {
        const s = 0.4 + t * GRENADE_RADIUS;
        blast.scale.set(s, s, s);
        blast.material.opacity = 0.85 * (1 - t);
        blastLight.intensity = 60 * (1 - t);
      }
    }
    for (let i = active.length - 1; i >= 0; i--) {
      const g = active[i];
      g.fuse -= dt;
      bounceGrenade(g, dt);
      if (g.fuse <= 0) {
        scene.remove(g.mesh);
        explode(g);
        active.splice(i, 1);
      }
    }
  }

  applyStyle();

  return {
    state,
    grenades: active,
    def,
    setWeapon,
    step,
    ready() {
      return state.mag > 0 && state.cooldown === 0 && state.reloadLeft === 0;
    },
    pullTrigger() {
      state.cooldown = def().gap;
      state.flash = FLASH_TIME;
      state.kick = 0.055;
      if (safeHooks.onShot) safeHooks.onShot();
    },
    takeRound() {
      if (state.mag <= 0) return false;
      state.mag -= 1;
      return true;
    },
    reload() {
      const d = def();
      if (state.reloadLeft > 0 || state.mag === d.mag || state.reserve === 0) return;
      state.reloadLeft = d.reload;
    },
    spread(speed) {
      const d = def();
      return d.spreadStill + Math.min(1, speed / MOVE_REFERENCE) * d.spreadMove;
    },
    refill() {
      const d = def();
      state.mag = d.mag;
      state.reserve = d.reserve;
      state.cooldown = 0;
      state.reloadLeft = 0;
      state.flash = 0;
      state.kick = 0;
    },
    throwGrenade(origin, dir) {
      if (state.grenades <= 0) return false;
      state.grenades -= 1;
      const mesh = new THREE.Mesh(grenadeGeo, grenadeMat);
      mesh.position.copy(origin);
      scene.add(mesh);
      active.push({
        pos: origin.clone(),
        vel: new THREE.Vector3(dir.x * GRENADE_THROW_SPEED, dir.y * GRENADE_THROW_SPEED + GRENADE_THROW_UP, dir.z * GRENADE_THROW_SPEED),
        fuse: GRENADE_FUSE,
        mesh,
      });
      return true;
    },
  };
}
