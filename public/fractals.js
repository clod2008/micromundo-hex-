// MICROMUNDO — modelos 3D fractales
// Cada elemento del mundo es una estructura fractal generada por código
// (The Nature of Code, cap. 8): recursión + autosimilitud.
// Se generan una sola vez por variante y se comparten entre todas las instancias.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// mergeGeometries exige que todas sean indexadas o todas no indexadas
const flat = (g) => (g.index ? g.toNonIndexed() : g);
const merge = (parts) => mergeGeometries(parts.map(flat));

// ================================
// ÁRBOL FRACTAL — cada rama termina en N ramas más chicas (ramificación recursiva)
// ================================
function branchingTree({ depth, length, radius, spread, children, shrink, leafSize, seed }) {
  const rand = mulberry32(seed);
  const wood = [];
  const leaves = [];
  const up = new THREE.Vector3(0, 1, 0);

  function branch(start, dir, len, rad, level) {
    const end = start.clone().addScaledVector(dir, len);
    const seg = new THREE.CylinderGeometry(rad * shrink, rad, len, 5, 1);
    seg.translate(0, len / 2, 0);
    seg.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, dir));
    seg.translate(start.x, start.y, start.z);
    wood.push(seg);

    if (level === 0) {
      const leaf = new THREE.IcosahedronGeometry(leafSize * (0.8 + rand() * 0.4), 0);
      leaf.translate(end.x, end.y, end.z);
      leaves.push(leaf);
      return;
    }

    const twist = rand() * Math.PI * 2;
    for (let i = 0; i < children; i++) {
      const yaw = twist + (i / children) * Math.PI * 2;
      const tilt = spread * (0.75 + rand() * 0.5);
      // dirección hija = dirección padre inclinada `tilt` y girada `yaw` alrededor de ella
      const side = new THREE.Vector3(1, 0, 0);
      if (Math.abs(dir.x) > 0.9) side.set(0, 0, 1);
      const axis = side.cross(dir).normalize().applyAxisAngle(dir, yaw);
      const child = dir.clone().applyAxisAngle(axis, tilt).normalize();
      child.y = Math.max(child.y, 0.15); // las ramas no apuntan al piso
      branch(end, child.normalize(), len * (0.68 + rand() * 0.12), rad * shrink, level - 1);
    }
  }

  branch(new THREE.Vector3(), up.clone(), length, radius, depth);
  return { wood: merge(wood), leaves: leaves.length ? merge(leaves) : null };
}

// ================================
// TETRAEDRO DE SIERPINSKI — semilla
// ================================
function sierpinski(size, depth) {
  const parts = [];
  const base = new THREE.TetrahedronGeometry(1, 0);
  // vértices del tetraedro regular (para ubicar las 4 copias)
  const corners = [[1, 1, 1], [-1, -1, 1], [-1, 1, -1], [1, -1, -1]].map((v) => new THREE.Vector3(...v).normalize());

  function rec(center, s, level) {
    if (level === 0) {
      const g = base.clone();
      g.scale(s, s, s);
      g.translate(center.x, center.y, center.z);
      parts.push(g);
      return;
    }
    for (const c of corners) rec(center.clone().addScaledVector(c, s / 2), s / 2, level - 1);
  }
  rec(new THREE.Vector3(), size, depth);
  const g = merge(parts);
  g.translate(0, size * 0.6, 0);
  return g;
}

// ================================
// HEXAFLAKE — manantial (el mismo hexágono del terreno, repetido en sí mismo)
// ================================
function hexaflake(size, depth) {
  const parts = [];
  function rec(x, z, s, level) {
    if (level === 0) {
      const g = new THREE.CylinderGeometry(s, s, 0.06, 6);
      g.translate(x, 0, z);
      parts.push(g);
      return;
    }
    const child = s / 3;
    rec(x, z, child, level - 1); // centro
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      rec(x + Math.cos(a) * child * 2, z + Math.sin(a) * child * 2, child, level - 1);
    }
  }
  rec(0, 0, size, depth);
  const g = merge(parts);
  g.translate(0, 0.04, 0);
  return g;
}

// ================================
// ROCA — ruido fractal: varias octavas de la misma deformación, cada una a mitad de escala
// ================================
function fractalRock(size, seed) {
  const rand = mulberry32(seed);
  const g = new THREE.IcosahedronGeometry(size, 3);
  const waves = Array.from({ length: 4 }, (_, o) => ({
    dir: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
    freq: 2 ** o * 3,
    amp: 0.18 / 2 ** o,
    phase: rand() * 10,
  }));
  const pos = g.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = v.clone().normalize();
    let d = 0;
    for (const w of waves) d += Math.sin(n.dot(w.dir) * w.freq + w.phase) * w.amp;
    v.multiplyScalar(1 + d);
    v.y *= 0.7; // achatada, apoyada en el piso
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  g.translate(0, size * 0.45, 0);
  return g;
}

// ================================
// SPHEREFLAKE — animal (esfera con esferas hijas, con esferas nietas…)
// ================================
function sphereflake(size, depth) {
  const parts = [];
  const dirs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].map((d) => new THREE.Vector3(...d));
  function rec(center, r, level, from) {
    const g = new THREE.IcosahedronGeometry(r, 1);
    g.translate(center.x, center.y, center.z);
    parts.push(g);
    if (level === 0) return;
    for (const d of dirs) {
      if (from && d.dot(from) < -0.9) continue; // no volver hacia el padre
      const cr = r * 0.42;
      rec(center.clone().addScaledVector(d, r + cr * 0.8), cr, level - 1, d);
    }
  }
  rec(new THREE.Vector3(0, size, 0), size, depth, null);
  return merge(parts);
}

// ================================
// ANIMAL — sphereflake único armado desde su genoma (lo manda el servidor).
// Cada esfera tiene `arms` hijas alrededor de su propio eje; el ángulo, el tamaño
// relativo y la profundidad cambian de animal en animal.
// ================================
const GENE_KEYS = ['seed', 'size', 'ratio', 'depth', 'arms', 'spread', 'stretch', 'hue'];

export function createAnimalMesh(genes) {
  const g = Object.fromEntries(GENE_KEYS.map((k, i) => [k, genes[i]]));
  const rand = mulberry32(g.seed);
  const up = new THREE.Vector3(0, 1, 0);

  // presupuesto de esferas: si arms^depth explota, se recorta la profundidad
  let depth = g.depth;
  while (depth > 1 && (g.arms ** (depth + 1) - 1) / (g.arms - 1) > 60) depth--;

  // direcciones de los brazos en el marco local de cada esfera (eje = +Y)
  const twist = rand() * Math.PI * 2;
  const local = Array.from({ length: g.arms }, (_, i) => {
    const yaw = twist + (i / g.arms) * Math.PI * 2 + (rand() - 0.5) * 0.5;
    const tilt = g.spread + (rand() - 0.5) * 0.3;
    return new THREE.Vector3(Math.cos(yaw) * Math.cos(tilt), Math.sin(tilt), Math.sin(yaw) * Math.cos(tilt));
  });

  const parts = [];
  function rec(center, r, level, axis) {
    const s = new THREE.IcosahedronGeometry(r, level === depth ? 1 : 0);
    s.translate(center.x, center.y, center.z);
    parts.push(s);
    if (level === 0) return;
    const q = new THREE.Quaternion().setFromUnitVectors(up, axis);
    const cr = r * g.ratio;
    for (const d of local) {
      const dir = d.clone().applyQuaternion(q);
      rec(center.clone().addScaledVector(dir, r + cr * 0.75), cr, level - 1, dir);
    }
  }
  rec(new THREE.Vector3(), g.size, depth, up.clone());

  const geo = merge(parts);
  geo.scale(g.stretch, 1, 1 / Math.sqrt(g.stretch));
  geo.computeBoundingBox();
  geo.translate(0, -geo.boundingBox.min.y, 0); // apoyado en el piso

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(g.hue, 0.55, 0.55),
    flatShading: true,
    roughness: 0.45,
    metalness: 0.1,
  });
  material.userData.glow = true; // bioluminiscencia nocturna (la maneja el ciclo de día y noche)
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

// ================================
// CATÁLOGO DE MODELOS
// ================================
const VARIANTS = 4;

const MAT = {
  wood: new THREE.MeshStandardMaterial({ color: 0x6b5340, flatShading: true, roughness: 1 }),
  leaf: new THREE.MeshStandardMaterial({ color: 0x4f7f3a, flatShading: true, roughness: 0.9 }),
  bushLeaf: new THREE.MeshStandardMaterial({ color: 0x6e9447, flatShading: true, roughness: 0.9 }),
  sprout: new THREE.MeshStandardMaterial({ color: 0x9cc06a, flatShading: true }),
  seed: new THREE.MeshStandardMaterial({ color: 0xc9a46a, flatShading: true }),
  spring: new THREE.MeshStandardMaterial({ color: 0x8fd3e0, emissive: 0x4fc3d9, emissiveIntensity: 1.6, roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.9 }),
  stone: new THREE.MeshStandardMaterial({ color: 0x8e8a83, flatShading: true, roughness: 1 }),
  animal: new THREE.MeshStandardMaterial({ color: 0xe0a35c, flatShading: true, roughness: 0.45, metalness: 0.1 }),
};

const MODELS = { tree: [], bush: [], sprout: [], seed: [], spring: [], stone: [], animal: [] };

for (let i = 0; i < VARIANTS; i++) {
  const s = 1000 + i * 77;
  MODELS.tree.push(branchingTree({ depth: 4, length: 0.75, radius: 0.09, spread: 0.55, children: 3, shrink: 0.7, leafSize: 0.16, seed: s }));
  MODELS.bush.push(branchingTree({ depth: 3, length: 0.28, radius: 0.05, spread: 0.9, children: 3, shrink: 0.75, leafSize: 0.13, seed: s + 1 }));
  MODELS.sprout.push(branchingTree({ depth: 2, length: 0.16, radius: 0.025, spread: 0.6, children: 2, shrink: 0.7, leafSize: 0.07, seed: s + 2 }));
  MODELS.stone.push(fractalRock(0.55, s + 3));
}
MODELS.seed.push(sierpinski(0.18, 2));
MODELS.spring.push(hexaflake(0.8, 2));
MODELS.animal.push(sphereflake(0.3, 2));

// Devuelve un Object3D nuevo para el tipo pedido; `variant` elige la forma (estable por hexágono)
export function createElementMesh(type, variant = 0) {
  const obj = buildElementMesh(type, variant);
  obj?.traverse((m) => { if (m.isMesh) m.castShadow = m.receiveShadow = type !== 'spring'; });
  return obj;
}

function buildElementMesh(type, variant) {
  const list = MODELS[type];
  if (!list || !list.length) return null;
  const m = list[variant % list.length];

  if (type === 'tree' || type === 'bush' || type === 'sprout') {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(m.wood, MAT.wood));
    const leafMat = type === 'tree' ? MAT.leaf : type === 'bush' ? MAT.bushLeaf : MAT.sprout;
    if (m.leaves) group.add(new THREE.Mesh(m.leaves, leafMat));
    group.rotation.y = variant * 1.7;
    return group;
  }
  const mesh = new THREE.Mesh(m, MAT[type]);
  mesh.rotation.y = variant * 1.3;
  return mesh;
}
