// Molten Core: planting ignites the site furnace. Hold E inside a site
// for 3.5 s to plant the Core; once planted it burns for 35 s with
// accelerating beeps, then detonates. A defender can channel a 5 s defuse
// at the site to cool the Core down. The mesh stays hidden while carried.
// main.js drives startPlant/cancelPlant from the E key and startDefuse when
// a defender bot is channeling at the site; step() watches ctx.defusing /
// ctx.attackerNearSite to break a channel that is no longer valid.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const PLANT_SECONDS = 3.5;
const DEFUSE_SECONDS = 5;
const BOMB_TIMER = 35;
const BEEP_FINAL_SECONDS = 5;

export function createBomb(scene, world, state, hooks) {
  const h = hooks || {};
  const boxMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PALETTE.surface),
    roughness: 0.7,
    metalness: 0.3,
  });
  const lampMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.danger) });
  const group = new THREE.Group();
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.44), boxMat);
  box.position.y = 0.1;
  box.castShadow = true;
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), lampMat);
  lamp.position.set(0, 0.24, 0);
  group.add(box, lamp);
  group.visible = false;
  scene.add(group);

  let planting = false;
  let plantSite = null;
  let defusing = false;
  let beepIn = 0;
  let blinkIn = 0;

  const bomb = {
    status: 'carried',
    plantProgress: 0,
    defuseProgress: 0,
    site: null,
    timer: 0,
    position: new THREE.Vector3(0, -10, 0),

    startPlant(site) {
      if (bomb.status !== 'carried' || planting) return false;
      if (!world.sites || !world.sites[site]) return false;
      planting = true;
      plantSite = site;
      bomb.plantProgress = 0;
      return true;
    },

    cancelPlant() {
      planting = false;
      plantSite = null;
      bomb.plantProgress = 0;
    },

    startDefuse() {
      if (bomb.status !== 'planted' || defusing) return false;
      defusing = true;
      bomb.defuseProgress = 0;
      return true;
    },

    reset() {
      planting = false;
      plantSite = null;
      defusing = false;
      beepIn = 0;
      blinkIn = 0;
      bomb.status = 'carried';
      bomb.plantProgress = 0;
      bomb.defuseProgress = 0;
      bomb.site = null;
      bomb.timer = 0;
      bomb.position.set(0, -10, 0);
      group.visible = false;
      lamp.visible = true;
    },

    step(dt, ctx) {
      if (dt <= 0) return;

      if (planting && bomb.status === 'carried') {
        bomb.plantProgress += dt / PLANT_SECONDS;
        if (bomb.plantProgress >= 1) {
          bomb.plantProgress = 1;
          planting = false;
          bomb.status = 'planted';
          bomb.site = plantSite;
          bomb.timer = BOMB_TIMER;
          beepIn = 0;
          blinkIn = 0;
          const center = world.sites[plantSite].center;
          bomb.position.set(center.x, 0, center.z);
          group.position.copy(bomb.position);
          group.visible = true;
          if (h.onPlanted) h.onPlanted(plantSite);
          if (state && state.emit) state.emit('bombPlanted', { site: plantSite });
          plantSite = null;
        }
        return;
      }

      if (bomb.status !== 'planted') return;

      bomb.timer -= dt;

      // Beeps and the blinking lamp both accelerate as the timer runs down.
      beepIn -= dt;
      if (beepIn <= 0) {
        const frac = Math.max(0, bomb.timer / BOMB_TIMER);
        beepIn = 0.25 + 0.75 * frac;
        if (h.beep) h.beep(bomb.timer <= BEEP_FINAL_SECONDS);
      }
      blinkIn -= dt;
      if (blinkIn <= 0) {
        const frac = Math.max(0, bomb.timer / BOMB_TIMER);
        blinkIn = 0.12 + 0.5 * frac;
        lamp.visible = !lamp.visible;
      }

      // A live channel follows ctx.defusing as well as the explicit
      // startDefuse() call, so either driving style resumes a channel
      // after it was broken; an attacker near the site breaks it.
      if (ctx && ctx.defusing === true) defusing = true;
      if (defusing) {
        if ((ctx && ctx.defusing === false) || (ctx && ctx.attackerNearSite === true)) {
          defusing = false;
          bomb.defuseProgress = 0;
        } else {
          bomb.defuseProgress += dt / DEFUSE_SECONDS;
          if (bomb.defuseProgress >= 1) {
            bomb.defuseProgress = 1;
            defusing = false;
            bomb.status = 'defused';
            group.visible = false;
            if (h.onDefused) h.onDefused();
            if (state && state.emit) state.emit('bombDefused', { site: bomb.site });
            return;
          }
        }
      }

      if (bomb.timer <= 0) {
        bomb.timer = 0;
        bomb.status = 'exploded';
        lamp.visible = false;
        if (h.onExplode) h.onExplode(bomb.position);
        if (state && state.emit) state.emit('explosion', { pos: bomb.position });
      }
    },
  };

  return bomb;
}
