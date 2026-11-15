// The Crucible: EMBERLINE's signature. A molten pit at mid that vents on
// a timer (~every 25 s, 4 s vent): a steam column bursts up, the ember glow
// flares, and anyone standing inside radius 4 m takes 10 damage/s. While
// venting it is a real tactical event — it denies mid, blocks sightlines
// through the steam, and bots repath around it (main.js forwards the vent
// state to the bots every tick and on the state 'vent' event).
// The pit itself is always there; only the vent comes and goes.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const CENTER = new THREE.Vector3(0, 0, 2);
const RADIUS = 4;
const CYCLE_SECONDS = 25;
const VENT_SECONDS = 4;
const DAMAGE_PER_SECOND = 10;
const PARTICLE_COUNT = 42;

export function createCrucible(scene, state) {
  // The pit: a dark disc sunk into the floor, a rust rim ring, and an ember
  // disc that glows brighter as a vent builds.
  const pit = new THREE.Mesh(
    new THREE.CircleGeometry(RADIUS, 40),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.canvas), roughness: 0.9, metalness: 0.1 }),
  );
  pit.rotation.x = -Math.PI / 2;
  pit.position.set(CENTER.x, 0.03, CENTER.z);
  pit.receiveShadow = true;
  scene.add(pit);

  const rim = new THREE.Mesh(
    new THREE.RingGeometry(RADIUS - 0.25, RADIUS + 0.25, 48),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.rust), roughness: 0.85, metalness: 0.2 }),
  );
  rim.rotation.x = -Math.PI / 2;
  rim.position.set(CENTER.x, 0.04, CENTER.z);
  rim.receiveShadow = true;
  scene.add(rim);

  const ember = new THREE.Mesh(
    new THREE.CircleGeometry(RADIUS - 0.5, 40),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.accent), transparent: true, opacity: 0.25 }),
  );
  ember.rotation.x = -Math.PI / 2;
  ember.position.set(CENTER.x, 0.05, CENTER.z);
  scene.add(ember);

  // The vent: a steam column that fades in while venting, lit from below.
  const steam = new THREE.Mesh(
    new THREE.CylinderGeometry(2.4, 3.4, 6.5, 20, 1, true),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(PALETTE.ink),
      transparent: true,
      opacity: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  steam.position.set(CENTER.x, 3.25, CENTER.z);
  scene.add(steam);

  const glow = new THREE.PointLight(new THREE.Color(PALETTE.accent), 6, 20);
  glow.position.set(CENTER.x, 1.6, CENTER.z);
  scene.add(glow);

  // Rising embers: one Points cloud, positions recycled, never reallocated.
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const speeds = new Float32Array(PARTICLE_COUNT);
  for (let i = 0; i < PARTICLE_COUNT; i += 1) {
    const a = (i / PARTICLE_COUNT) * Math.PI * 2;
    const r = 0.4 + ((i * 37) % 10) / 10 * 2.6;
    positions[i * 3] = CENTER.x + Math.cos(a) * r;
    positions[i * 3 + 1] = 0.2 + ((i * 53) % 10) / 10 * 5;
    positions[i * 3 + 2] = CENTER.z + Math.sin(a) * r;
    speeds[i] = 1.4 + ((i * 29) % 10) / 10 * 1.6;
  }
  const particleGeo = new THREE.BufferGeometry();
  particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const particles = new THREE.Points(particleGeo, new THREE.PointsMaterial({
    color: new THREE.Color(PALETTE.accent),
    size: 0.14,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  }));
  particles.frustumCulled = false;
  scene.add(particles);

  let cycleT = 0;
  let active = false;
  let ventAmount = 0;

  function emitVent() {
    if (state && state.emit) state.emit('vent', { center: CENTER, radius: RADIUS, active });
  }

  const crucible = {
    center: CENTER,
    radius: RADIUS,
    damagePerSecond: DAMAGE_PER_SECOND,
    get active() {
      return active;
    },

    ventState() {
      return { center: CENTER, radius: RADIUS, active };
    },

    // Staging only (?shot=start): force the vent on so the menu vista
    // shows the Crucible lit. Uses the same state + event path as a
    // natural vent, so what the screenshot shows is the real vent.
    setVent(on) {
      if (on === active) return;
      active = on;
      cycleT = on ? CYCLE_SECONDS - VENT_SECONDS : 0;
      emitVent();
    },

    reset() {
      cycleT = 0;
      if (active) {
        active = false;
        emitVent();
      }
    },

    step(dt) {
      if (dt <= 0) return;
      cycleT += dt;
      if (cycleT >= CYCLE_SECONDS) cycleT -= CYCLE_SECONDS;
      const shouldVent = cycleT >= CYCLE_SECONDS - VENT_SECONDS;
      if (shouldVent !== active) {
        active = shouldVent;
        emitVent();
      }
      // Ease the visuals toward the vent state; the steam never snaps.
      const target = active ? 1 : 0;
      ventAmount += (target - ventAmount) * Math.min(1, dt * (active ? 6 : 2.5));
      steam.material.opacity = 0.34 * ventAmount;
      steam.rotation.y += dt * 0.25 * ventAmount;
      ember.material.opacity = 0.25 + 0.55 * ventAmount;
      glow.intensity = 6 + 54 * ventAmount;
      particles.material.opacity = 0.9 * ventAmount;
      if (ventAmount > 0.02) {
        const attr = particleGeo.getAttribute('position');
        const arr = attr.array;
        for (let i = 0; i < PARTICLE_COUNT; i += 1) {
          arr[i * 3 + 1] += speeds[i] * dt * ventAmount;
          if (arr[i * 3 + 1] > 6.5) arr[i * 3 + 1] = 0.2;
        }
        attr.needsUpdate = true;
      }
    },
  };

  return crucible;
}
