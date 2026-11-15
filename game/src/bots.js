// Bots: 5 Foundry defenders (ct, blue) + 2 Ember friendly attackers (t,
// red-orange). Defenders hold site/mid posts, rotate toward heard shots,
// and converge on a planted Molten Core to defuse when no attacker is near
// the site. Friendly attackers push one site along the waypoint graph and
// fight. The map's central Crucible vent is a timed no-go zone: while a
// vent is active, bots repath around its circle instead of walking through
// it (see ventZone below).
//
// Movement is BFS over world.waypoints with the same one-axis-at-a-time
// AABB collision as the player. Shooting needs line of sight, waits out a
// 0.4-0.8 s reaction, then fires bursts of 3-5 with a pause; aim error
// grows with distance and target speed, so a strafing player survives.
// Tracers come from a small shared pool of fading lines; no per-frame
// allocation happens in step().
//
// Damage ownership: this module owns bot health. damage() is the single
// entry for outside damage (player shots, grenades) and reports kills via
// hooks.onBotKilled(bot, true). Bot-vs-bot shots apply damage internally
// through the same kill path; hooks.damageBot is a notification only, so
// main.js must NOT re-apply it. hooks.damagePlayer is the only route by
// which bots hurt the player (main.js applies it to player health).
import * as THREE from 'three';
import { PALETTE } from './palette.js';

const BOT_HEALTH = 100;
const WALK_SPEED = 3.4;
const ROTATE_SPEED = 4.2;
const RADIUS = 0.34;
const HEIGHT = 1.72;
const EYE_HEIGHT = 1.5;
const CHEST_HEIGHT = 1.2;
const SIGHT_RANGE = 38;
const REACT_MIN = 0.4;
const REACT_MAX = 0.8;
const SHOT_GAP = 0.11;
const BURST_MIN = 3;
const BURST_MAX = 5;
const BURST_PAUSE_MIN = 0.7;
const BURST_PAUSE_MAX = 1.2;
const TARGET_LOST_SECONDS = 1.5;
const HEAR_RANGE = 26;
const HEAR_MEMORY_SECONDS = 2.5;
const ROTATE_HOLD_SECONDS = 4;
const DEFUSE_RANGE = 8;
const CONVERGE_TICK = 0.5;
const TRACER_POOL = 12;
const TRACER_LIFE = 0.09;
const FALL_SECONDS = 0.4;

export function createBots(scene, world, hooks, bus) {
  const h = hooks || {};
  const colliders = world.colliders || [];
  const shootables = world.shootables || [];

  // Shared geometry / materials: one set per team, reused by every bot.
  const torsoGeo = new THREE.BoxGeometry(0.52, 0.78, 0.3);
  const headGeo = new THREE.SphereGeometry(0.155, 16, 12);
  const gunGeo = new THREE.BoxGeometry(0.09, 0.12, 0.62);
  const mats = {
    ct: {
      torso: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ct), roughness: 0.6, metalness: 0.1 }),
      head: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.ct), roughness: 0.45, metalness: 0.1 }),
      gun: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.8, metalness: 0.2 }),
    },
    t: {
      torso: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.t), roughness: 0.6, metalness: 0.1 }),
      head: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.t), roughness: 0.45, metalness: 0.1 }),
      gun: new THREE.MeshStandardMaterial({ color: new THREE.Color(PALETTE.hairline), roughness: 0.8, metalness: 0.2 }),
    },
  };

  // Waypoint graph: adjacency once, BFS only when a bot repaths.
  const nodes = (world.waypoints && world.waypoints.nodes) || [];
  const adjacency = new Map();
  for (const node of nodes) adjacency.set(node.id, []);
  if (world.waypoints && world.waypoints.edges) {
    for (const edge of world.waypoints.edges) {
      const a = adjacency.get(edge[0]);
      const b = adjacency.get(edge[1]);
      if (a && b) {
        a.push(edge[1]);
        b.push(edge[0]);
      }
    }
  }

  function nearestNodeId(x, z) {
    let best = null;
    let bestD = Infinity;
    for (const node of nodes) {
      const dx = node.pos.x - x;
      const dz = node.pos.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = node.id;
      }
    }
    return best;
  }

  function nodePos(id) {
    for (const node of nodes) if (node.id === id) return node.pos;
    return null;
  }

  function bfsPath(startId, goalId) {
    if (startId === null || goalId === null) return null;
    if (startId === goalId) return [startId];
    const prev = new Map([[startId, null]]);
    const queue = [startId];
    for (let qi = 0; qi < queue.length; qi += 1) {
      const cur = queue[qi];
      const neighbours = adjacency.get(cur) || [];
      for (const nb of neighbours) {
        if (prev.has(nb)) continue;
        prev.set(nb, cur);
        if (nb === goalId) {
          const path = [goalId];
          let at = cur;
          while (at !== null) {
            path.unshift(at);
            at = prev.get(at);
          }
          return path;
        }
        queue.push(nb);
      }
    }
    return null;
  }

  // Reused scratch objects: step() and the shooting code never allocate.
  const raycaster = new THREE.Raycaster();
  const probe = new THREE.Box3();
  const tmpEye = new THREE.Vector3();
  const tmpDir = new THREE.Vector3();
  const tmpMuzzle = new THREE.Vector3();
  const tmpAim = new THREE.Vector3();
  const tmpEnd = new THREE.Vector3();
  const tmpForward = new THREE.Vector3();
  // Reused acquisition scratch: consider() writes here, never allocates.
  const acq = { ref: null, kind: null, x: 0, y: 0, z: 0, speed: 0, distSq: Infinity };

  // Tracer pool: prebuilt lines, each reused once its fade finishes.
  const tracers = [];
  for (let i = 0; i < TRACER_POOL; i += 1) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(PALETTE.ink), transparent: true, opacity: 0 });
    const line = new THREE.Line(geo, mat);
    line.visible = false;
    line.frustumCulled = false;
    scene.add(line);
    tracers.push({ line, life: 0 });
  }
  let tracerCursor = 0;

  function spawnTracer(from, to, team) {
    const tracer = tracers[tracerCursor];
    tracerCursor = (tracerCursor + 1) % TRACER_POOL;
    const attr = tracer.line.geometry.getAttribute('position');
    attr.array[0] = from.x;
    attr.array[1] = from.y;
    attr.array[2] = from.z;
    attr.array[3] = to.x;
    attr.array[4] = to.y;
    attr.array[5] = to.z;
    attr.needsUpdate = true;
    tracer.line.material.color.set(team === 'ct' ? PALETTE.ct : PALETTE.t);
    tracer.life = TRACER_LIFE;
    tracer.line.visible = true;
    tracer.line.material.opacity = 0.85;
  }

  function overlaps(x, z) {
    probe.min.set(x - RADIUS, 0.04, z - RADIUS);
    probe.max.set(x + RADIUS, HEIGHT - 0.04, z + RADIUS);
    for (const collider of colliders) {
      if (probe.intersectsBox(collider)) return true;
    }
    if (world.bounds) {
      if (x < world.bounds.minX || x > world.bounds.maxX) return true;
      if (z < world.bounds.minZ || z > world.bounds.maxZ) return true;
    }
    return false;
  }

  function makeBot(id, team) {
    const group = new THREE.Group();
    const torso = new THREE.Mesh(torsoGeo, mats[team].torso);
    torso.position.y = 1.0;
    torso.castShadow = true;
    const head = new THREE.Mesh(headGeo, mats[team].head);
    head.position.y = 1.53;
    head.castShadow = true;
    const gun = new THREE.Mesh(gunGeo, mats[team].gun);
    gun.position.set(0.26, 1.18, -0.28);
    gun.castShadow = true;
    group.add(torso, head, gun);
    scene.add(group);

    const bot = {
      id,
      team,
      group,
      torso,
      head,
      health: BOT_HEALTH,
      alive: true,
      yaw: 0,
      mode: 'hold',
      waypoint: new THREE.Vector3(),
      reaction: 0,
      burstLeft: 0,
      nextShot: 0,
      home: new THREE.Vector3(),
      path: [],
      pathIndex: 0,
      dest: new THREE.Vector3(),
      hasDest: false,
      target: null,
      targetPos: new THREE.Vector3(),
      targetSpeed: 0,
      targetDist: 0,
      reactUntil: 0,
      lostAt: -1,
      fall: 0,
      defusing: false,
      converge: false,
      heardAppliedAt: -100,
      holdUntil: 0,
      pushSite: 'A',
      moveSpeed: 0,
      lastHitPart: null,
    };
    torso.userData.bot = bot;
    torso.userData.part = 'torso';
    head.userData.bot = bot;
    head.userData.part = 'head';
    return bot;
  }

  const list = [];
  for (let i = 0; i < 5; i += 1) list.push(makeBot('ct-' + i, 'ct'));
  for (let i = 0; i < 2; i += 1) list.push(makeBot('t-' + i, 't'));
  const hitMeshes = [];
  for (const bot of list) hitMeshes.push(bot.torso, bot.head);

  // Last heard shot, shared by all bots: set by bot fire and by shot
  // events main.js passes in ctx.events.
  const shotHeard = { pos: new THREE.Vector3(), at: -100 };

  // Crucible vent: a timed no-go circle driven by main.js. One zone only,
  // updated from the state 'vent' event ({ center, radius, active }).
  // main.js may pass the state emitter as the optional 4th argument, or
  // forward vent data in step's ctx (ctx.vent, or a { type: 'vent' }
  // entry in ctx.events); all three routes land in onVent.
  const ventCenter = new THREE.Vector3();
  let ventZone = null;

  function onVent(data) {
    if (data && data.active && data.center && typeof data.radius === 'number') {
      ventCenter.set(data.center.x, 0, data.center.z);
      ventZone = { center: ventCenter, radius: data.radius };
    } else {
      ventZone = null;
    }
  }

  if (bus && typeof bus.on === 'function') bus.on('vent', onVent);

  function insideVent(x, z) {
    if (!ventZone) return false;
    const dx = x - ventZone.center.x;
    const dz = z - ventZone.center.z;
    const r = ventZone.radius + 0.5;
    return dx * dx + dz * dz < r * r;
  }

  function nearestSafeNode(x, z) {
    let bestPos = null;
    let bestD = Infinity;
    for (const node of nodes) {
      if (insideVent(node.pos.x, node.pos.z)) continue;
      const dx = node.pos.x - x;
      const dz = node.pos.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        bestPos = node.pos;
      }
    }
    return bestPos;
  }

  function hearShot(pos, time) {
    shotHeard.pos.copy(pos);
    shotHeard.at = time;
  }

  function setPath(bot, goalX, goalZ) {
    // A goal inside an active vent is replaced by the nearest waypoint
    // outside the vent circle.
    if (insideVent(goalX, goalZ)) {
      const safe = nearestSafeNode(goalX, goalZ);
      if (safe) {
        goalX = safe.x;
        goalZ = safe.z;
      }
    }
    const startId = nearestNodeId(bot.group.position.x, bot.group.position.z);
    const goalId = nearestNodeId(goalX, goalZ);
    const ids = bfsPath(startId, goalId);
    bot.path.length = 0;
    if (ids) {
      for (const id of ids) {
        const p = nodePos(id);
        if (p) bot.path.push(new THREE.Vector3(p.x, 0, p.z));
      }
    }
    bot.path.push(new THREE.Vector3(goalX, 0, goalZ));
    bot.pathIndex = 0;
    bot.dest.set(goalX, 0, goalZ);
    bot.waypoint.copy(bot.dest);
    bot.hasDest = true;
  }

  function clearPath(bot) {
    bot.path.length = 0;
    bot.pathIndex = 0;
    bot.hasDest = false;
  }

  function faceToward(bot, x, z) {
    const dx = x - bot.group.position.x;
    const dz = z - bot.group.position.z;
    if (dx * dx + dz * dz < 0.0001) return;
    bot.yaw = Math.atan2(-dx, -dz);
    bot.group.rotation.y = bot.yaw;
  }

  function muzzlePos(bot, out) {
    tmpForward.set(-Math.sin(bot.yaw), 0, -Math.cos(bot.yaw));
    out.set(
      bot.group.position.x + tmpForward.x * 0.5,
      bot.group.position.y + 1.35,
      bot.group.position.z + tmpForward.z * 0.5
    );
    return out;
  }

  function hasLineOfSight(fromX, fromY, fromZ, toX, toY, toZ) {
    tmpDir.set(toX - fromX, toY - fromY, toZ - fromZ);
    const dist = tmpDir.length();
    if (dist < 0.001) return true;
    tmpDir.divideScalar(dist);
    raycaster.set(tmpEye.set(fromX, fromY, fromZ), tmpDir);
    raycaster.far = dist;
    const hits = raycaster.intersectObjects(shootables, false);
    return hits.length === 0 || hits[0].distance > dist - 0.3;
  }

  function killBot(bot, byPlayer) {
    if (!bot.alive) return;
    bot.alive = false;
    bot.health = 0;
    bot.fall = 0;
    bot.target = null;
    bot.burstLeft = 0;
    bot.defusing = false;
    bot.converge = false;
    if (h.onBotKilled) h.onBotKilled(bot, byPlayer);
  }

  function damageBotInternal(bot, amount, part) {
    if (!bot.alive) return;
    bot.health -= amount;
    bot.lastHitPart = part;
    if (bot.health <= 0) killBot(bot, false);
  }

  function damage(mesh, amount, part) {
    const bot = mesh && mesh.userData ? mesh.userData.bot : null;
    if (!bot || !bot.alive) return false;
    bot.health -= amount;
    bot.lastHitPart = part || null;
    if (bot.health > 0) return false;
    killBot(bot, true);
    return true;
  }

  function acquireTarget(bot, ctx, time) {
    const eyeX = bot.group.position.x;
    const eyeY = bot.group.position.y + EYE_HEIGHT;
    const eyeZ = bot.group.position.z;
    acq.ref = null;
    acq.kind = null;
    acq.distSq = SIGHT_RANGE * SIGHT_RANGE;

    function consider(x, y, z, distSq, ref, kind, speed) {
      if (distSq >= acq.distSq) return;
      if (!hasLineOfSight(eyeX, eyeY, eyeZ, x, y, z)) return;
      acq.distSq = distSq;
      acq.ref = ref;
      acq.kind = kind;
      acq.x = x;
      acq.y = y;
      acq.z = z;
      acq.speed = speed;
    }

    if (bot.team === 'ct') {
      if (ctx.playerAlive && ctx.playerPos) {
        const dx = ctx.playerPos.x - eyeX;
        const dz = ctx.playerPos.z - eyeZ;
        consider(ctx.playerPos.x, ctx.playerPos.y + CHEST_HEIGHT, ctx.playerPos.z,
          dx * dx + dz * dz, null, 'player', ctx.playerSpeed || 0);
      }
      for (const other of list) {
        if (other.team !== 't' || !other.alive) continue;
        const dx = other.group.position.x - eyeX;
        const dz = other.group.position.z - eyeZ;
        consider(other.group.position.x, other.group.position.y + CHEST_HEIGHT,
          other.group.position.z, dx * dx + dz * dz, other, 'bot', other.moveSpeed);
      }
    } else {
      for (const other of list) {
        if (other.team !== 'ct' || !other.alive) continue;
        const dx = other.group.position.x - eyeX;
        const dz = other.group.position.z - eyeZ;
        consider(other.group.position.x, other.group.position.y + CHEST_HEIGHT,
          other.group.position.z, dx * dx + dz * dz, other, 'bot', other.moveSpeed);
      }
    }

    if (!acq.kind) {
      if (!bot.target) return;
      if (bot.lostAt < 0) {
        bot.lostAt = time;
      } else if (time - bot.lostAt > TARGET_LOST_SECONDS) {
        bot.target = null;
        bot.lostAt = -1;
      }
      return;
    }
    bot.lostAt = -1;
    const isNew = !bot.target || bot.target.kind !== acq.kind || bot.target.ref !== acq.ref;
    if (isNew) {
      bot.target = { kind: acq.kind, ref: acq.ref };
      bot.reactUntil = time + REACT_MIN + Math.random() * (REACT_MAX - REACT_MIN);
      bot.reaction = bot.reactUntil - time;
      bot.burstLeft = 0;
      bot.nextShot = 0;
    }
    bot.targetPos.set(acq.x, acq.y, acq.z);
    bot.targetSpeed = acq.speed;
    bot.targetDist = Math.sqrt(acq.distSq);
  }

  function fireShot(bot, time) {
    muzzlePos(bot, tmpMuzzle);
    const dx = bot.targetPos.x - tmpMuzzle.x;
    const dy = bot.targetPos.y - tmpMuzzle.y;
    const dz = bot.targetPos.z - tmpMuzzle.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    // Aim error grows with range, with how fast the target is moving, and
    // with the shooter's own movement, so a strafing player at range is
    // hard to hit and fire on the move is suppressive, not lethal.
    const err = 0.3 + dist * 0.012 + bot.targetSpeed * 0.09 + bot.moveSpeed * 0.06;
    tmpAim.set(
      bot.targetPos.x + (Math.random() * 2 - 1) * err,
      bot.targetPos.y + (Math.random() * 2 - 1) * err * 0.7,
      bot.targetPos.z + (Math.random() * 2 - 1) * err
    );
    tmpDir.set(tmpAim.x - tmpMuzzle.x, tmpAim.y - tmpMuzzle.y, tmpAim.z - tmpMuzzle.z).normalize();
    raycaster.set(tmpMuzzle, tmpDir);
    raycaster.far = 60;
    const wallHits = raycaster.intersectObjects(shootables, false);
    const wallDist = wallHits.length ? wallHits[0].distance : 60;

    const hitChance = Math.max(0.08, Math.min(0.62,
      0.62 - dist * 0.008 - bot.targetSpeed * 0.06 - bot.moveSpeed * 0.02));
    const hit = Math.random() < hitChance && dist < wallDist;
    if (hit) {
      tmpEnd.copy(bot.targetPos);
    } else {
      tmpEnd.set(
        tmpMuzzle.x + tmpDir.x * Math.min(wallDist, 40),
        tmpMuzzle.y + tmpDir.y * Math.min(wallDist, 40),
        tmpMuzzle.z + tmpDir.z * Math.min(wallDist, 40)
      );
    }
    spawnTracer(tmpMuzzle, tmpEnd, bot.team);

    if (hit) {
      const part = Math.random() < 0.15 ? 'head' : 'torso';
      let dmg = 13 + Math.random() * 6;
      if (part === 'head') dmg *= 2;
      dmg = Math.round(dmg);
      if (bot.target.kind === 'player') {
        if (h.damagePlayer) h.damagePlayer(dmg, bot);
      } else if (bot.target.ref && bot.target.ref.alive) {
        const victim = bot.target.ref;
        const mesh = part === 'head' ? victim.head : victim.torso;
        // Bot-vs-bot hits are softened so a push is not erased by the
        // first defender that sees it; damage to the player is full.
        const botDmg = Math.max(1, Math.round(dmg * 0.6));
        damageBotInternal(victim, botDmg, part);
        if (h.damageBot) h.damageBot(mesh, botDmg, part, bot.team === 't');
      }
    }

    hearShot(tmpMuzzle, time);
    if (h.onShot) h.onShot(new THREE.Vector3(tmpMuzzle.x, tmpMuzzle.y, tmpMuzzle.z));
  }

  function moveAlongPath(bot, dt, speed) {
    // Skip path nodes that fall inside an active vent instead of walking
    // through the circle.
    while (bot.pathIndex < bot.path.length) {
      const node = bot.path[bot.pathIndex];
      if (!insideVent(node.x, node.z)) break;
      bot.pathIndex += 1;
    }
    if (!bot.hasDest || bot.pathIndex >= bot.path.length) {
      bot.moveSpeed = 0;
      return true;
    }
    const node = bot.path[bot.pathIndex];
    const dx = node.x - bot.group.position.x;
    const dz = node.z - bot.group.position.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 0.4) {
      bot.pathIndex += 1;
      if (bot.pathIndex >= bot.path.length) {
        bot.moveSpeed = 0;
        return true;
      }
      return false;
    }
    const stepLen = speed * dt;
    const mx = (dx / d) * stepLen;
    const mz = (dz / d) * stepLen;
    const px = bot.group.position.x;
    const pz = bot.group.position.z;
    if (!overlaps(px + mx, pz)) bot.group.position.x = px + mx;
    if (!overlaps(bot.group.position.x, pz + mz)) bot.group.position.z = pz + mz;
    bot.moveSpeed = speed;
    faceToward(bot, node.x, node.z);
    return false;
  }

  function bombInfo(ctx) {
    if (!ctx) return null;
    if (ctx.bomb && ctx.bomb.planted) {
      return {
        planted: true,
        site: ctx.bomb.site || null,
        pos: ctx.bomb.pos || null,
      };
    }
    if (ctx.bombPlanted) {
      return { planted: true, site: ctx.bombSite || null, pos: ctx.bombPos || null };
    }
    return null;
  }

  function attackerNearSite(ctx, sitePos) {
    if (!sitePos) return false;
    if (ctx.playerAlive && ctx.playerPos) {
      const dx = ctx.playerPos.x - sitePos.x;
      const dz = ctx.playerPos.z - sitePos.z;
      if (dx * dx + dz * dz < DEFUSE_RANGE * DEFUSE_RANGE) return true;
    }
    for (const other of list) {
      if (other.team !== 't' || !other.alive) continue;
      const dx = other.group.position.x - sitePos.x;
      const dz = other.group.position.z - sitePos.z;
      if (dx * dx + dz * dz < DEFUSE_RANGE * DEFUSE_RANGE) return true;
    }
    return false;
  }

  let convergeTimer = 0;

  function step(dt, time, ctx) {
    if (dt <= 0) return;
    const context = ctx || {};

    for (const tracer of tracers) {
      if (tracer.life <= 0) continue;
      tracer.life -= dt;
      if (tracer.life <= 0) {
        tracer.line.visible = false;
        tracer.line.material.opacity = 0;
      } else {
        tracer.line.material.opacity = 0.85 * (tracer.life / TRACER_LIFE);
      }
    }

    // Shot sounds from main.js (player fire, grenades): any defender in
    // earshot notes the position for a rotate. Vent updates arrive the
    // same way, or via ctx.vent.
    if (context.vent) onVent(context.vent);
    if (Array.isArray(context.events)) {
      for (const evt of context.events) {
        if (!evt) continue;
        const kind = evt.type || evt.kind;
        const pos = evt.pos || evt.position;
        if (kind === 'shot' && pos) hearShot(pos, time);
        if (kind === 'vent') onVent(evt);
      }
    }

    const bomb = bombInfo(context);
    let sitePos = null;
    if (bomb && bomb.pos) {
      sitePos = bomb.pos;
    } else if (bomb && bomb.site && world.sites && world.sites[bomb.site]) {
      sitePos = world.sites[bomb.site].center;
    }

    // Throttled converge decision: when the bomb is planted and no live
    // attacker is within 8 m of the site, the two nearest live defenders
    // converge to defuse; otherwise they stay and fight.
    convergeTimer -= dt;
    if (bomb && sitePos && convergeTimer <= 0) {
      convergeTimer = CONVERGE_TICK;
      const near = attackerNearSite(context, sitePos);
      const liveCt = [];
      for (const bot of list) if (bot.team === 'ct' && bot.alive) liveCt.push(bot);
      liveCt.sort((a, b) => {
        const da = (a.group.position.x - sitePos.x) ** 2 + (a.group.position.z - sitePos.z) ** 2;
        const db = (b.group.position.x - sitePos.x) ** 2 + (b.group.position.z - sitePos.z) ** 2;
        return da - db;
      });
      for (let i = 0; i < liveCt.length; i += 1) {
        liveCt[i].converge = !near && i < 2;
        if (!liveCt[i].converge) liveCt[i].defusing = false;
      }
    }
    if (!bomb) {
      for (const bot of list) {
        bot.converge = false;
        bot.defusing = false;
      }
    }

    for (const bot of list) {
      if (!bot.alive) {
        if (bot.fall < 1) {
          bot.fall = Math.min(1, bot.fall + dt / FALL_SECONDS);
          bot.group.rotation.x = -bot.fall * 1.45;
          bot.group.position.y = -bot.fall * 0.08;
        }
        continue;
      }

      acquireTarget(bot, context, time);

      // A vent that switched on under a bot's current destination sends
      // it to the nearest waypoint outside the circle instead.
      if (ventZone && bot.hasDest && insideVent(bot.dest.x, bot.dest.z)) {
        setPath(bot, bot.dest.x, bot.dest.z);
      }

      // A vent may have parked a friendly pusher at a safe waypoint short
      // of the site; once it clears, resume the push before anything else.
      if (bot.team === 't' && bot.mode === 'hold' && !ventZone) {
        const hx = bot.home.x - bot.group.position.x;
        const hz = bot.home.z - bot.group.position.z;
        if (hx * hx + hz * hz > 2.25) {
          bot.mode = 'push';
          setPath(bot, bot.home.x, bot.home.z);
        }
      }

      // Decide movement. Holders plant their feet and shoot; a bot that is
      // still pushing keeps moving toward its objective and fires on the
      // move instead of freezing the first time it sees an enemy. A
      // defender with a defuse to run does not get pinned down by a
      // distant target; only a close threat (< 12 m) breaks it off.
      const mustDefuse = bot.converge && bomb && sitePos;
      const haltToShoot = bot.target && (bot.team === 'ct' || bot.mode === 'hold')
        && (!mustDefuse || bot.targetDist < 12);
      if (haltToShoot) {
        // Plant feet and shoot; face the target. Fighting breaks a defuse.
        bot.defusing = false;
        faceToward(bot, bot.targetPos.x, bot.targetPos.z);
        bot.moveSpeed = 0;
      } else if (bot.team === 'ct') {
        if (bomb && sitePos && bot.converge) {
          bot.mode = 'defuse';
          const sdx = sitePos.x - bot.group.position.x;
          const sdz = sitePos.z - bot.group.position.z;
          if (sdx * sdx + sdz * sdz < 1.44) {
            bot.defusing = true;
            bot.moveSpeed = 0;
          } else {
            bot.defusing = false;
            if (!bot.hasDest || ((bot.dest.x !== sitePos.x || bot.dest.z !== sitePos.z) && !ventZone)) {
              setPath(bot, sitePos.x, sitePos.z);
            }
            moveAlongPath(bot, dt, ROTATE_SPEED);
          }
        } else if (time - shotHeard.at < HEAR_MEMORY_SECONDS && bot.heardAppliedAt !== shotHeard.at) {
          const dx = shotHeard.pos.x - bot.group.position.x;
          const dz = shotHeard.pos.z - bot.group.position.z;
          if (dx * dx + dz * dz < HEAR_RANGE * HEAR_RANGE) {
            bot.heardAppliedAt = shotHeard.at;
            bot.mode = 'rotate';
            setPath(bot, shotHeard.pos.x, shotHeard.pos.z);
          }
        } else if (bot.mode === 'rotate') {
          if (moveAlongPath(bot, dt, ROTATE_SPEED)) {
            bot.mode = 'hold';
            bot.holdUntil = time + ROTATE_HOLD_SECONDS;
          }
        } else if (bot.mode === 'hold' && time >= bot.holdUntil) {
          const dx = bot.home.x - bot.group.position.x;
          const dz = bot.home.z - bot.group.position.z;
          const standingInVent = insideVent(bot.group.position.x, bot.group.position.z);
          if (dx * dx + dz * dz > 0.25 || standingInVent) {
            if (!bot.hasDest) setPath(bot, bot.home.x, bot.home.z);
            if (moveAlongPath(bot, dt, WALK_SPEED)) clearPath(bot);
          } else {
            bot.moveSpeed = 0;
            clearPath(bot);
          }
        } else {
          bot.moveSpeed = 0;
        }
      } else {
        // Friendly attacker: push the assigned site, then hold it.
        if (bot.mode === 'push') {
          if (moveAlongPath(bot, dt, WALK_SPEED)) bot.mode = 'hold';
        } else {
          bot.moveSpeed = 0;
        }
      }

      // Burst fire once the reaction delay has elapsed.
      if (bot.target && time >= bot.reactUntil && time >= bot.nextShot) {
        if (bot.burstLeft > 0) {
          fireShot(bot, time);
          bot.burstLeft -= 1;
          bot.nextShot = time + SHOT_GAP;
        } else {
          bot.burstLeft = BURST_MIN + Math.floor(Math.random() * (BURST_MAX - BURST_MIN + 1));
          bot.nextShot = time + BURST_PAUSE_MIN + Math.random() * (BURST_PAUSE_MAX - BURST_PAUSE_MIN);
        }
      }
    }
  }

  function reset(roundNum) {
    const pushSite = roundNum % 2 === 1 ? 'A' : 'B';
    const ctSpawns = (world.spawns && world.spawns.ct) || [];
    const tSpawns = (world.spawns && world.spawns.t) || [];

    // Hold posts: two defenders near each site, one mid.
    const holdSpots = [];
    if (world.sites && world.sites.A) holdSpots.push(world.sites.A.center);
    if (world.sites && world.sites.B) holdSpots.push(world.sites.B.center);
    if (world.bounds) {
      holdSpots.push(new THREE.Vector3(
        (world.bounds.minX + world.bounds.maxX) / 2,
        0,
        (world.bounds.minZ + world.bounds.maxZ) / 2
      ));
    }
    const holdFor = [0, 0, 1, 1, 2];
    const holdOffsets = [
      [1.2, 0.8], [-1.2, -0.8], [1.2, -0.8], [-1.2, 0.8], [0, 0],
    ];

    let ctIndex = 0;
    let tIndex = 0;
    for (const bot of list) {
      bot.health = BOT_HEALTH;
      bot.alive = true;
      bot.fall = 0;
      bot.target = null;
      bot.burstLeft = 0;
      bot.nextShot = 0;
      bot.reactUntil = 0;
      bot.reaction = 0;
      bot.lostAt = -1;
      bot.defusing = false;
      bot.converge = false;
      bot.heardAppliedAt = -100;
      bot.holdUntil = 0;
      bot.moveSpeed = 0;
      bot.lastHitPart = null;
      bot.group.rotation.set(0, 0, 0);
      bot.group.position.y = 0;
      clearPath(bot);

      if (bot.team === 'ct') {
        const spawn = ctSpawns[ctIndex] || new THREE.Vector3(-8 + ctIndex * 4, 0, -12);
        bot.group.position.copy(spawn);
        const spot = holdSpots[holdFor[ctIndex]] || spawn;
        const off = holdOffsets[ctIndex];
        bot.home.set(spot.x + off[0], 0, spot.z + off[1]);
        bot.waypoint.copy(bot.home);
        bot.mode = 'hold';
        bot.yaw = Math.PI;
        bot.group.rotation.y = bot.yaw;
        ctIndex += 1;
      } else {
        const spawn = tSpawns[tIndex + 1] || tSpawns[tIndex] || new THREE.Vector3(0, 0, 12);
        bot.group.position.copy(spawn);
        bot.pushSite = pushSite;
        bot.mode = 'push';
        bot.yaw = 0;
        bot.group.rotation.y = bot.yaw;
        const site = world.sites ? world.sites[pushSite] : null;
        if (site) {
          bot.home.copy(site.center);
          bot.waypoint.copy(site.center);
          setPath(bot, site.center.x, site.center.z);
        } else {
          bot.home.copy(spawn);
          bot.waypoint.copy(spawn);
        }
        tIndex += 1;
      }
    }
    shotHeard.at = -100;
    convergeTimer = 0;
  }

  function aliveCount(team) {
    let n = 0;
    for (const bot of list) {
      if (!bot.alive) continue;
      if (team === undefined || bot.team === team) n += 1;
    }
    return n;
  }

  function aimPoint(i) {
    const bot = list[i % list.length];
    return new THREE.Vector3(bot.group.position.x, CHEST_HEIGHT, bot.group.position.z);
  }

  return { list, hitMeshes, step, damage, aliveCount, reset, aimPoint };
}
