// EMBERLINE map: a ~44 x 36 m decommissioned foundry / power-plant yard.
// Three lanes: A-long (west) to Turbine Hall, mid pipe lane (centre), B-tunnel (east)
// to Coal Yard. Attackers spawn at the south gate; defenders split across the
// two sites and mid. Plain geometry only, no textures, no external assets.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

export function createMap(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const materials = {};
  for (const name of Object.keys(PALETTE)) {
    materials[name] = new THREE.MeshStandardMaterial({
      color: new THREE.Color(PALETTE[name]),
      roughness: name === 'accent' || name === 'ink' ? 0.55 : 0.92,
      metalness: 0.03,
    });
  }

  const colliders = [];
  const shootables = [];

  // Every solid box is both a collider (movement) and a shootable (bullets stop).
  function box(width, height, depth, x, y, z, material) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), materials[material]);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    colliders.push(new THREE.Box3().setFromObject(mesh));
    shootables.push(mesh);
    return mesh;
  }

  // A flat glowing ring marking a site on the floor (visual only, not a collider).
  function siteRing(x, z) {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(2.9, 3.2, 48),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.site), side: THREE.DoubleSide })
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.02, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }

  // ---- floor ----
  box(44.4, 0.4, 36.4, 0, -0.2, 0, 'canvas');

  // ---- outer walls (4.6 m high, yard is 44 x 36 m) ----
  box(44.4, 4.6, 0.4, 0, 2.3, -18.2, 'surface');
  box(44.4, 4.6, 0.4, 0, 2.3, 18.2, 'surface');
  box(0.4, 4.6, 36.4, -22.2, 2.3, 0, 'surface');
  box(0.4, 4.6, 36.4, 22.2, 2.3, 0, 'surface');

  // ---- lane dividers (3.4 m high) ----
  // Each divider leaves two gaps (z -9..-3 and z 1..7) so bots can cross lanes,
  // and stops at z = 12 so the south spawn corridor (z 12..18) stays open.
  // West divider x = -11, east divider x = 11.
  for (const x of [-11, 11]) {
    box(0.4, 3.4, 9, x, 1.7, -13.5, 'surface');
    box(0.4, 3.4, 4, x, 1.7, -1, 'surface');
    box(0.4, 3.4, 5, x, 1.7, 9.5, 'surface');
  }

  // ---- A-long (west lane) ----
  // Turbine block guarding site A, crouch crates and a pillar for cover.
  box(4.5, 2.8, 3.5, -16.8, 1.4, -14.5, 'rust');
  box(1.2, 1.1, 1.2, -19, 0.55, -2, 'hairline');
  box(1.6, 0.7, 1.6, -14, 0.35, 4, 'hairline');
  box(1.2, 3.2, 1.2, -13.5, 1.6, -15.5, 'concrete');
  box(1.2, 3.2, 1.2, -12, 1.6, -8.5, 'concrete');

  // ---- B-tunnel (east lane) ----
  // Coal piles (low mounds) around site B, crouch crates and a pillar for cover.
  box(2.4, 0.7, 2.4, 12.8, 0.35, -14.8, 'sand');
  box(2.4, 0.7, 2.4, 17.8, 0.35, -14.2, 'sand');
  box(2.0, 0.6, 2.0, 17.5, 0.3, -8.8, 'sand');
  box(1.2, 1.1, 1.2, 19, 0.55, -2, 'hairline');
  box(1.6, 0.7, 1.6, 14, 0.35, 4, 'hairline');
  box(1.2, 3.2, 1.2, 12, 1.6, -8.5, 'concrete');

  // ---- mid pipe lane (centre) ----
  // Raised platform overlooking mid from the west, low pipes to crouch behind,
  // crate rows, containers guarding the south approach, pillars by the south gate.
  box(7, 1.2, 3.5, -6.5, 0.6, -6, 'concrete');
  box(1.2, 1.1, 1.2, -7.5, 1.75, -6, 'hairline');
  box(1.2, 1.1, 1.2, -5.5, 1.75, -6, 'hairline');
  box(1, 0.9, 5, -4, 0.45, 6.5, 'rust');
  box(1, 0.9, 4, 5.5, 0.45, 7.5, 'rust');
  box(1.2, 1.1, 3.6, -5, 0.55, 0, 'hairline');
  box(3.6, 1.1, 1.2, 5, 0.55, 0, 'hairline');
  box(1.2, 1.1, 1.2, -1.5, 0.55, 8, 'hairline');
  box(1.2, 1.1, 1.2, 3, 0.55, 8, 'hairline');
  box(5.5, 2.6, 2.4, -7.5, 1.3, 10, 'rust');
  box(5.5, 2.6, 2.4, 7.5, 1.3, 10, 'rust');
  box(1.2, 3.2, 1.2, -5, 1.6, 13, 'concrete');
  box(1.2, 3.2, 1.2, 5, 1.6, 13, 'concrete');

  // ---- sites ----
  const sites = {
    A: { center: new THREE.Vector3(-15, 0, -11), radius: 3.2, name: 'Turbine Hall' },
    B: { center: new THREE.Vector3(15, 0, -11), radius: 3.2, name: 'Coal Yard' },
  };
  siteRing(-15, -11);
  siteRing(15, -11);
  // Site letter boards: a plain accent panel on two posts at each site's south
  // edge (geometry only — no text textures). The panel is a solid box.
  for (const cx of [-15, 15]) {
    box(2.6, 1.6, 0.15, cx, 2.0, -7.2, 'accent');
    box(0.15, 1.2, 0.15, cx - 1.1, 0.6, -7.2, 'hairline');
    box(0.15, 1.2, 0.15, cx + 1.1, 0.6, -7.2, 'hairline');
  }

  // ---- lighting: warm dusk key, warm sky/ground, cool fill ----
  const sky = new THREE.HemisphereLight(
    new THREE.Color(PALETTE.accent), new THREE.Color(PALETTE.canvas), 0.9
  );
  scene.add(sky);

  const key = new THREE.DirectionalLight(new THREE.Color(PALETTE.ink), 2.1);
  key.position.set(12, 16, 10);
  key.target.position.set(0, 0, -2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -26;
  key.shadow.camera.right = 26;
  key.shadow.camera.top = 22;
  key.shadow.camera.bottom = -22;
  key.shadow.camera.far = 60;
  key.shadow.bias = -0.0006;
  scene.add(key, key.target);

  const fill = new THREE.DirectionalLight(new THREE.Color(PALETTE.ct), 0.5);
  fill.position.set(-10, 9, 12);
  scene.add(fill);

  // ---- spawns ----
  // Attackers (t) at the south gate; defenders (ct) split 2 at A, 2 at B, 1 mid.
  const spawns = {
    ct: [
      new THREE.Vector3(-16.5, 0, -8.5),
      new THREE.Vector3(-13, 0, -13.5),
      new THREE.Vector3(0, 0, -9),
      new THREE.Vector3(15.5, 0, -8.5),
      new THREE.Vector3(13, 0, -13.5),
    ],
    t: [
      new THREE.Vector3(-14, 0, 15),
      new THREE.Vector3(-7, 0, 15),
      new THREE.Vector3(0, 0, 15),
      new THREE.Vector3(7, 0, 15),
      new THREE.Vector3(14, 0, 15),
    ],
  };

  // ---- waypoints ----
  // 19 nodes covering all three lanes and both sites. Every edge is a straight
  // walkable line: it never crosses a wall, divider, crate, pipe or platform.
  const nodes = [
    { id: 0, pos: new THREE.Vector3(-15, 0, -11) },
    { id: 1, pos: new THREE.Vector3(-17, 0, -6) },
    { id: 2, pos: new THREE.Vector3(-17, 0, 0) },
    { id: 3, pos: new THREE.Vector3(-17, 0, 8) },
    { id: 4, pos: new THREE.Vector3(-14, 0, 15) },
    { id: 5, pos: new THREE.Vector3(0, 0, -9) },
    { id: 6, pos: new THREE.Vector3(0, 0, -2) },
    { id: 7, pos: new THREE.Vector3(0, 0, 3) },
    { id: 8, pos: new THREE.Vector3(0, 0, 10) },
    { id: 9, pos: new THREE.Vector3(0, 0, 15) },
    { id: 10, pos: new THREE.Vector3(15, 0, -11) },
    { id: 11, pos: new THREE.Vector3(17, 0, -6) },
    { id: 12, pos: new THREE.Vector3(17, 0, 0) },
    { id: 13, pos: new THREE.Vector3(17, 0, 8) },
    { id: 14, pos: new THREE.Vector3(14, 0, 15) },
    { id: 15, pos: new THREE.Vector3(-8, 0, -2) },
    { id: 16, pos: new THREE.Vector3(8, 0, -6) },
    { id: 17, pos: new THREE.Vector3(-8, 0, 4) },
    { id: 18, pos: new THREE.Vector3(8, 0, 4) },
  ];
  const edges = [
    [0, 1], [1, 2], [2, 3], [3, 4], [4, 9], [9, 14],
    [14, 13], [13, 12], [12, 11], [11, 10],
    [5, 6], [6, 7], [7, 8], [8, 9],
    [1, 15], [15, 6], [15, 16], [16, 6], [11, 16], [5, 16],
    [2, 17], [17, 7], [12, 18], [18, 7], [3, 17], [13, 18],
  ];

  return {
    colliders,
    shootables,
    group,
    spawns,
    sites,
    waypoints: { nodes, edges },
    bounds: { minX: -22, maxX: 22, minZ: -18, maxZ: 18 },
    name: 'EMBERLINE',
  };
}
