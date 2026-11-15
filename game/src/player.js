// Player movement for EMBERLINE: walk / crouch / jump with gravity, resolved
// against the world's axis-aligned colliders one axis at a time, so sliding
// along a wall never lets the player sink into it. Spawn is set by main.js
// through state.position; this module owns only motion and collision.
import * as THREE from 'three';

const HALF_WIDTH = 0.34;
const HEIGHT_STAND = 1.72;
const HEIGHT_CROUCH = 1.12;
const EYE_STAND = 1.6;
const EYE_CROUCH = 1.02;
const SPEED_WALK = 5.2;
const SPEED_CROUCH = 2.4;
const ACCEL_GROUND = 42;
const ACCEL_AIR = 9;
const FRICTION = 9;
const GRAVITY = 20;
const JUMP_SPEED = 6.2;
const MAX_FALL = 30;
const PITCH_LIMIT = 1.45;
const LOOK_SENS = 0.0022;

export function createPlayer(colliders) {
  const body = {
    position: new THREE.Vector3(0, 0, 9.5),
    velocity: new THREE.Vector3(),
    yaw: 0,
    pitch: 0,
    eye: EYE_STAND,
    onGround: true,
    crouching: false,
    height: HEIGHT_STAND,
    armor: 0,
  };
  const probe = new THREE.Box3();
  const wishDir = new THREE.Vector3();

  // Returns the first collider the player's box would touch at (x, y, z),
  // or null. `lift` trims the box ends so the floor underfoot and the ceiling
  // above the head are not mistaken for a wall during horizontal moves.
  function firstHit(x, y, z, height, lift) {
    probe.min.set(x - HALF_WIDTH, y + lift, z - HALF_WIDTH);
    probe.max.set(x + HALF_WIDTH, y + height - lift, z + HALF_WIDTH);
    for (let i = 0; i < colliders.length; i++) {
      if (probe.intersectsBox(colliders[i])) return colliders[i];
    }
    return null;
  }

  function look(dx, dy) {
    body.yaw -= dx * LOOK_SENS;
    body.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, body.pitch - dy * LOOK_SENS));
  }

  function recoil(pitchKick, yawKick) {
    body.pitch = Math.min(PITCH_LIMIT, body.pitch + pitchKick);
    body.yaw += yawKick;
  }

  function step(dt, keys) {
    const wantCrouch = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC');
    if (wantCrouch && !body.crouching) {
      body.crouching = true;
      body.height = HEIGHT_CROUCH;
    } else if (!wantCrouch && body.crouching) {
      // Stand only when the full-height box fits where the player stands.
      if (!firstHit(body.position.x, body.position.y, body.position.z, HEIGHT_STAND, 0.02)) {
        body.crouching = false;
        body.height = HEIGHT_STAND;
      }
    }
    const eyeTarget = body.crouching ? EYE_CROUCH : EYE_STAND;
    body.eye += (eyeTarget - body.eye) * Math.min(1, dt * 12);

    const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    wishDir.set(0, 0, 0);
    if (forward !== 0 || strafe !== 0) {
      const sin = Math.sin(body.yaw);
      const cos = Math.cos(body.yaw);
      wishDir.set(-sin * forward + cos * strafe, 0, -cos * forward - sin * strafe).normalize();
    }

    const topSpeed = body.crouching ? SPEED_CROUCH : SPEED_WALK;
    const accel = body.onGround ? ACCEL_GROUND : ACCEL_AIR;
    const blend = Math.min(1, (accel * dt) / topSpeed);
    body.velocity.x += (wishDir.x * topSpeed - body.velocity.x) * blend;
    body.velocity.z += (wishDir.z * topSpeed - body.velocity.z) * blend;
    if (body.onGround && wishDir.lengthSq() === 0) {
      const damp = Math.max(0, 1 - FRICTION * dt);
      body.velocity.x *= damp;
      body.velocity.z *= damp;
    }

    if (keys.has('Space') && body.onGround) {
      body.velocity.y = JUMP_SPEED;
      body.onGround = false;
    }
    body.velocity.y -= GRAVITY * dt;

    // Horizontal axes resolve separately: a blocked X move still allows Z.
    const nextX = body.position.x + body.velocity.x * dt;
    if (!firstHit(nextX, body.position.y, body.position.z, body.height, 0.04)) {
      body.position.x = nextX;
    } else {
      body.velocity.x = 0;
    }
    const nextZ = body.position.z + body.velocity.z * dt;
    if (!firstHit(body.position.x, body.position.y, nextZ, body.height, 0.04)) {
      body.position.z = nextZ;
    } else {
      body.velocity.z = 0;
    }

    // Vertical axis: land on a box top when falling, bonk the head when rising.
    body.position.y += body.velocity.y * dt;
    body.onGround = false;
    const hit = firstHit(body.position.x, body.position.y, body.position.z, body.height, 0);
    if (hit && body.velocity.y <= 0) {
      body.position.y = hit.max.y;
      body.velocity.y = 0;
      body.onGround = true;
    } else if (hit) {
      body.position.y = hit.min.y - body.height;
      body.velocity.y = 0;
    }
    if (body.position.y < 0) {
      body.position.y = 0;
      body.velocity.y = 0;
      body.onGround = true;
    }
    body.velocity.y = Math.max(-MAX_FALL, body.velocity.y);
  }

  return {
    state: body,
    step,
    look,
    recoil,
    groundSpeed() {
      return Math.hypot(body.velocity.x, body.velocity.z);
    },
  };
}
