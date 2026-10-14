// MICROMUNDO — cliente
// Solo dibuja: recibe el mundo del servidor, anima los cambios y manda acciones.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Water } from 'three/addons/objects/Water.js';
import { createElementMesh, createAnimalMesh } from './fractals.js';
import { createSky, createMistLayer, shadeHexGeometry } from './shaders.js';

// ================================
// PARÁMETROS
// ================================
const PARAMS = {
  maxTiles: 2500,     // igual que en el servidor
  hexRadius: 0.95,    // < 1 deja una junta visible entre módulos
  hStep: 0.35,        // altura en unidades 3D por cada nivel de h
  base: -3,           // piso de los prismas (bajo el mar)
  lerp: new URLSearchParams(location.search).has('instant') ? 1 : 0.12, // suavizado de alturas (?instant lo apaga, para capturas)
  horizon: 0xaebfc2,   // = color de la niebla
  zenith: 0x5f7f8f,
  sunColor: 0xffe7c4,
  sea: 0x1e4650,
  fogDensity: 0.013,
  // Paletas del ciclo: se interpolan según la altura del sol
  palettes: {
    day:   { horizon: 0xaebfc2, zenith: 0x5f7f8f, light: 0xffe7c4, intensity: 2.2, hemi: 0.35, sea: 0x1e4650, mist: 0xe4eaea, exposure: 0.95 },
    dusk:  { horizon: 0xd9967a, zenith: 0x3f4d78, light: 0xffa866, intensity: 1.3, hemi: 0.22, sea: 0x2a3a52, mist: 0xe8c4b4, exposure: 0.95 },
    night: { horizon: 0x161e30, zenith: 0x04060d, light: 0x8ea6ff, intensity: 0.55, hemi: 0.16, sea: 0x060e18, mist: 0x34405a, exposure: 0.85 },
  },
  colors: {
    seabed: 0x6d7f74,
    soil: 0x9c8263,
    grass: 0x6b9a4f,
    dry: 0xb7a57e,
    rock: 0x8e8a83,
  },
};

const socket = io();

// ================================
// ESCENA — isla en la niebla
// ================================
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(PARAMS.horizon, PARAMS.fogDensity);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 900);
camera.position.set(22, 20, 22);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI / 2.15; // no pasar por debajo del mar
controls.minDistance = 6;
controls.maxDistance = 120;

// Sol (o luna, de noche) con sombras suaves. sunDir cambia con el ciclo de día y noche.
const sunDir = new THREE.Vector3(0.7, 0.45, 0.25).normalize();
const sun = new THREE.DirectionalLight(PARAMS.sunColor, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 250;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xcfdde0, 0x3a4a46, 0.35);
scene.add(hemi);

let worldRadius = 15;
function fitShadowToWorld(radius) {
  worldRadius = radius;
  const r = Math.max(15, radius + 4);
  const cam = sun.shadow.camera;
  cam.left = cam.bottom = -r;
  cam.right = cam.top = r;
  cam.updateProjectionMatrix();
  sun.position.copy(sunDir).multiplyScalar(r + 60);
}
fitShadowToWorld(15);

// Cielo (shader propio) + mapa de entorno generado desde ese cielo → reflejos en los materiales
const sky = createSky({ horizon: PARAMS.horizon, zenith: PARAMS.zenith, sunColor: PARAMS.sunColor, sunDir });
scene.add(sky);
{
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  envScene.add(createSky({ horizon: PARAMS.horizon, zenith: PARAMS.zenith, sunColor: PARAMS.sunColor, sunDir }));
  scene.environment = pmrem.fromScene(envScene, 0.02).texture;
}

// Mar con reflejos (shader Water de Three.js: reflexión plana + olas por normal map)
const waterNormals = new THREE.TextureLoader().load('textures/waternormals.jpg', (t) => {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
});
const sea = new Water(new THREE.PlaneGeometry(900, 900), {
  textureWidth: 1024,
  textureHeight: 1024,
  waterNormals,
  sunDirection: sunDir,
  sunColor: PARAMS.sunColor,
  waterColor: PARAMS.sea,
  distortionScale: 1.4,
  fog: true,
});
sea.rotation.x = -Math.PI / 2;
sea.position.y = 0.02;
sea.material.uniforms.size.value = 2.5;
scene.add(sea);

// Niebla baja tipo Myst: dos capas de volutas a distinta altura y velocidad
const mists = [
  createMistLayer({ y: 0.4, color: 0xdfe6e6, opacity: 0.45, scale: 0.035, speed: 0.025 }),
  createMistLayer({ y: 1.4, color: 0xe8eeee, opacity: 0.22, scale: 0.022, speed: -0.015 }),
];
mists.forEach((m) => scene.add(m));

// Postproceso: brillo suave en lo luminoso (manantiales, reflejos del sol)
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.35, 0.6, 0.82));
composer.addPass(new OutputPass());

// ================================
// DÍA Y NOCHE — misma hora para todos (reloj del servidor)
// fase 0 = amanecer 06:00 · 0.25 = mediodía · 0.5 = atardecer · 0.75 = medianoche
// ================================
const clock = { start: Date.now(), dayLengthMs: 360000, offset: 0 };
const pal = { horizon: new THREE.Color(), zenith: new THREE.Color(), light: new THREE.Color(), sea: new THREE.Color(), mist: new THREE.Color() };
const palB = {};
const moonDir = new THREE.Vector3();
let nightness = 0;
let lastEnvUpdate = 0;

function mixPalette(a, b, t) {
  for (const k of ['horizon', 'zenith', 'light', 'sea', 'mist']) {
    pal[k].setHex(a[k]).lerp((palB[k] ||= new THREE.Color()).setHex(b[k]), t);
  }
  for (const k of ['intensity', 'hemi', 'exposure']) pal[k] = a[k] + (b[k] - a[k]) * t;
}

function worldElapsed() { return Date.now() + clock.offset - clock.start; }

function updateDayNight(now) {
  const phase = (worldElapsed() / clock.dayLengthMs) % 1;
  const ang = phase * Math.PI * 2;
  const elev = Math.sin(ang);
  const P = PARAMS.palettes;

  if (elev >= 0) mixPalette(P.dusk, P.day, THREE.MathUtils.smoothstep(elev, 0, 0.4));
  else mixPalette(P.dusk, P.night, THREE.MathUtils.smoothstep(-elev, 0, 0.25));
  nightness = THREE.MathUtils.smoothstep(-elev, -0.05, 0.25);

  // el sol recorre un arco de este a oeste; de noche la luz la da la luna (lado opuesto)
  const sunPos = new THREE.Vector3(Math.cos(ang), Math.sin(ang), 0.35).normalize();
  moonDir.copy(sunPos).negate();
  const light = elev > -0.08 ? sunPos : moonDir;
  sunDir.copy(light);
  if (sunDir.y < 0.08) sunDir.y = 0.08; // la sombra nunca se estira al infinito
  sunDir.normalize();

  sun.color.copy(pal.light);
  sun.intensity = pal.intensity;
  sun.position.copy(sunDir).multiplyScalar(Math.max(15, worldRadius + 4) + 60);
  hemi.intensity = pal.hemi;
  renderer.toneMappingExposure = pal.exposure;
  scene.fog.color.copy(pal.horizon);

  const su = sky.material.uniforms;
  su.uHorizon.value.copy(pal.horizon);
  su.uZenith.value.copy(pal.zenith);
  su.uSunColor.value.copy(pal.light);
  su.uSunDir.value.copy(light);
  su.uStars.value = nightness;
  su.uHalo.value = elev > -0.08 ? 1 : 3;

  const wu = sea.material.uniforms;
  wu.sunDirection.value.copy(sunDir);
  wu.sunColor.value.copy(pal.light).multiplyScalar(Math.min(1, pal.intensity / 1.3)); // brillo del agua proporcional a la luz
  wu.waterColor.value.copy(pal.sea);
  for (const m of mists) m.material.uniforms.uColor.value.copy(pal.mist);

  // reflejos del entorno: el mapa es del cielo de día, se atenúa de noche.
  // Los animales se vuelven bioluminiscentes de noche.
  if (now - lastEnvUpdate > 400) {
    lastEnvUpdate = now;
    const env = 0.08 + 0.52 * (1 - nightness);
    scene.traverse((o) => {
      if (!o.isMesh || !o.material || !o.material.isMeshStandardMaterial) return;
      o.material.envMapIntensity = env;
      if (o.material.userData.glow) o.material.emissive.copy(o.material.color).multiplyScalar(0.55 * nightness);
    });
  }

  // HUD: día y hora
  const hours = (phase * 24 + 6) % 24;
  const hh = String(Math.floor(hours)).padStart(2, '0');
  const mm = String(Math.floor((hours % 1) * 60)).padStart(2, '0');
  clockEl.textContent = `${hh}:${mm}`;
  dayEl.textContent = `CICLO ${String(Math.floor(worldElapsed() / clock.dayLengthMs) + 1).padStart(2, '0')}`;
  phaseEl.textContent = nightness > 0.5 ? 'NOCHE' : elev > 0.25 ? 'DÍA' : phase < 0.25 || phase > 0.75 ? 'AMANECER' : 'ATARDECER';
  document.body.classList.toggle('is-night', nightness > 0.5);
}

const clockEl = document.getElementById('clock-time');
const dayEl = document.getElementById('clock-day');
const phaseEl = document.getElementById('clock-phase');

// ================================
// HEXÁGONOS — un solo InstancedMesh para todos los módulos
// ================================
const hexGeo = new THREE.CylinderGeometry(PARAMS.hexRadius, PARAMS.hexRadius, 1, 6);
hexGeo.translate(0, 0.5, 0); // el origen queda en la base del prisma
shadeHexGeometry(hexGeo);
const hexMat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85, vertexColors: true, envMapIntensity: 0.6 });
const hexes = new THREE.InstancedMesh(hexGeo, hexMat, PARAMS.maxTiles);
hexes.count = 0;
hexes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
hexes.castShadow = true;
hexes.receiveShadow = true;
scene.add(hexes);

const tiles = new Map();   // "q,r" → { q, r, h, m, v, cur, idx }
const byIndex = [];        // idx → tile
const animating = new Set();
const dummy = new THREE.Object3D();
const color = new THREE.Color();
const tmp = new THREE.Color();

const axialToWorld = (q, r) => ({ x: Math.sqrt(3) * (q + r / 2), z: 1.5 * r });
const topY = (h) => h * PARAMS.hStep;

function writeMatrix(t) {
  const { x, z } = axialToWorld(t.q, t.r);
  dummy.position.set(x, PARAMS.base, z);
  dummy.scale.set(1, Math.max(0.001, topY(t.cur) - PARAMS.base), 1);
  dummy.updateMatrix();
  hexes.setMatrixAt(t.idx, dummy.matrix);
  hexes.instanceMatrix.needsUpdate = true;
}

function writeColor(t) {
  const c = PARAMS.colors;
  if (t.h <= 0) {
    color.setHex(c.seabed);
  } else {
    color.setHex(c.dry).lerp(tmp.setHex(c.soil), t.m / 10);
    color.lerp(tmp.setHex(c.grass), t.v / 10);
    if (t.h >= 7) color.lerp(tmp.setHex(c.rock), Math.min(1, (t.h - 6) / 4));
  }
  hexes.setColorAt(t.idx, color);
  hexes.instanceColor.needsUpdate = true;
}

// mismos códigos que el servidor
const EL_NAMES = [null, 'seed', 'sprout', 'bush', 'tree', 'spring', 'stone'];

function placeElementMesh(t) {
  if (t.obj) { scene.remove(t.obj); t.obj = null; }
  const name = EL_NAMES[t.e];
  if (!name) return;
  const variant = Math.abs((t.q * 73856093) ^ (t.r * 19349663)) % 4; // forma estable por hexágono
  t.obj = createElementMesh(name, variant);
  t.obj.scale.setScalar(0.01); // aparece creciendo
  scene.add(t.obj);
}

function positionElement(t) {
  if (!t.obj) return;
  const { x, z } = axialToWorld(t.q, t.r);
  t.obj.position.set(x, topY(t.cur), z);
}

function upsertTile([q, r, h, m, v, e]) {
  const k = q + ',' + r;
  let t = tiles.get(k);
  if (!t) {
    if (hexes.count >= PARAMS.maxTiles) return;
    // los módulos nuevos emergen desde abajo
    t = { q, r, h, m, v, e: 0, obj: null, cur: PARAMS.base / PARAMS.hStep, idx: hexes.count++ };
    tiles.set(k, t);
    byIndex[t.idx] = t;
  }
  t.h = h; t.m = m; t.v = v;
  if (t.e !== e) { t.e = e; placeElementMesh(t); positionElement(t); }
  writeColor(t);
  animating.add(t);
}

// ================================
// ANIMALES — sphereflakes que caminan de hexágono en hexágono
// ================================
const animals = new Map(); // id → { obj, target }

function syncAnimals(list) {
  const alive = new Set();
  for (const [id, q, r, genes] of list) {
    alive.add(id);
    const t = tiles.get(q + ',' + r);
    const { x, z } = axialToWorld(q, r);
    const y = t ? topY(t.cur) : 0;
    let a = animals.get(id);
    if (!a) {
      a = { obj: createAnimalMesh(genes), target: new THREE.Vector3(x, y, z), pos: new THREE.Vector3(x, y, z) };
      a.obj.position.copy(a.pos);
      a.obj.scale.setScalar(0.01);
      scene.add(a.obj);
      animals.set(id, a);
    }
    if (a.target.x !== x || a.target.z !== z) a.obj.lookAt(x, a.obj.position.y, z);
    a.target.set(x, y, z);
  }
  for (const [id, a] of animals) {
    if (!alive.has(id)) {
      scene.remove(a.obj);
      a.obj.geometry.dispose(); // cada animal tiene geometría y material propios
      a.obj.material.dispose();
      animals.delete(id);
    }
  }
}

// ================================
// CURSORES REMOTOS — un cono del color de cada persona + etiqueta
// ================================
const labels = document.getElementById('labels');
const remote = new Map(); // id → { mesh, label, target }
const coneGeo = new THREE.ConeGeometry(0.3, 0.9, 12).rotateX(Math.PI);

function upsertCursor(c) {
  let rc = remote.get(c.id);
  if (!rc) {
    const mesh = new THREE.Mesh(coneGeo, new THREE.MeshStandardMaterial({ color: new THREE.Color(c.color) }));
    const label = document.createElement('div');
    label.className = 'cursor-label';
    label.style.color = c.color;
    label.textContent = 'visitante';
    labels.appendChild(label);
    scene.add(mesh);
    rc = { mesh, label, target: new THREE.Vector3() };
    remote.set(c.id, rc);
    mesh.position.set(c.x, c.y + 0.8, c.z);
  }
  rc.target.set(c.x, c.y + 0.8, c.z);
  rc.mesh.visible = c.y > -100; // y = -999 → todavía no apuntó a ningún hexágono
}

function removeCursor(id) {
  const rc = remote.get(id);
  if (!rc) return;
  scene.remove(rc.mesh);
  rc.mesh.material.dispose();
  rc.label.remove();
  remote.delete(id);
}

function updateStats() {
  document.getElementById('stat-tiles').textContent = tiles.size;
  document.getElementById('stat-people').textContent = remote.size + 1;
}

// ================================
// HITOS — panel de progreso de la etapa
// ================================
const progressEl = document.getElementById('progress');

function renderProgress(p) {
  if (!p) return;
  const rows = p.needs.map((n) => row(n.label, n.have, n.need)).join('');
  const people = p.contributors.need ? row('personas que aportaron', p.contributors.have, p.contributors.need) : '';
  const state = p.needs.length === 0
    ? 'El mundo crece libre.'
    : p.halted
      ? '⚠ CRECIMIENTO DETENIDO — cumplan el hito para seguir.'
      : `▲ Creciendo: ${p.tiles} / ${p.cap} hexágonos.`;
  const pad = (n) => String(n).padStart(2, '0');
  progressEl.innerHTML = `
    <div class="hud-tag">// ETAPA ${pad(p.stage)}/${pad(p.stages)}</div>
    <div class="stage">${p.name}</div>
    <div class="state${p.halted ? ' halted' : ''}">${state}</div>
    ${rows}${people}`;
}

function row(label, have, need) {
  const pct = Math.min(100, (have / need) * 100);
  return `<div class="need${have >= need ? ' done' : ''}">
    <div class="need-head"><span>${label}</span><b>${Math.min(have, need)}/${need}</b></div>
    <div class="bar"><i style="width:${pct}%"></i></div></div>`;
}

const toastEl = document.getElementById('toast');
let toastTimer;
function toast(tag, title) {
  toastEl.innerHTML = '<div class="hud-tag"></div><strong></strong>';
  toastEl.querySelector('.hud-tag').textContent = tag;
  toastEl.querySelector('strong').textContent = title;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4000);
}

// ================================
// HERRAMIENTAS — moldear o colocar (teclas 1-5)
// ================================
let tool = 'shape';
const toolButtons = [...document.querySelectorAll('#tools button')];
function setTool(name) {
  tool = name;
  toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === name));
}
toolButtons.forEach((b, i) => b.addEventListener('click', () => setTool(b.dataset.tool)));
addEventListener('keydown', (e) => {
  const b = toolButtons[Number(e.key) - 1];
  if (b) setTool(b.dataset.tool);
});

// ================================
// SOCKETS
// ================================
socket.on('world_init', (data) => {
  clock.start = data.time.start;
  clock.dayLengthMs = data.time.dayLengthMs;
  clock.offset = data.time.serverNow - Date.now();
  hoverMat.color.set(data.you.color);
  hoverLineMat.color.set(data.you.color);
  document.getElementById('stat-seed').textContent = data.seed;
  data.tiles.forEach(upsertTile);
  data.cursors.forEach(upsertCursor);
  syncAnimals(data.animals);
  renderProgress(data.progress);
  updateStats();
});

socket.on('animals', syncAnimals);
socket.on('progress', renderProgress);
socket.on('milestone', (m) => toast(`// HITO COMPLETADO: ${m.completed}`, `→ ${m.name}`));

socket.on('world_diff', (diff) => {
  diff.forEach(upsertTile);
  updateStats();
});

socket.on('cursor', (c) => { upsertCursor(c); updateStats(); });
socket.on('client_disconnected', (id) => { removeCursor(id); updateStats(); });

// ================================
// INTERACCIÓN — raycaster sobre los hexágonos
// ================================
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const hoverMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthTest: false });
const hoverLineMat = new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false });
const hexOutline = Array.from({ length: 7 }, (_, i) => {
  const a = (i / 6) * Math.PI * 2; // mismos vértices que el prisma (punta hacia z)
  return new THREE.Vector3(Math.sin(a) * PARAMS.hexRadius, 0, Math.cos(a) * PARAMS.hexRadius);
});
const hover = new THREE.Group();
hover.add(new THREE.Mesh(new THREE.CylinderGeometry(PARAMS.hexRadius, PARAMS.hexRadius, 0.02, 6), hoverMat));
hover.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(hexOutline), hoverLineMat));
hover.renderOrder = 10;
hover.children.forEach((c) => (c.renderOrder = 10));
hover.visible = false;
scene.add(hover);

let hovered = null;
let lastCursorSent = 0;

function pick(e) {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObject(hexes)[0];
  return hit ? { tile: byIndex[hit.instanceId], point: hit.point } : null;
}

renderer.domElement.addEventListener('pointermove', (e) => {
  const hit = pick(e);
  hovered = hit ? hit.tile : null;
  hover.visible = !!hovered;
  renderer.domElement.style.cursor = hovered ? 'crosshair' : 'grab';

  const now = performance.now();
  if (hit && now - lastCursorSent > 50) {
    lastCursorSent = now;
    socket.emit('cursor_move', { x: hit.point.x, y: hit.point.y, z: hit.point.z });
  }
});

// click (sin arrastre) = acción; arrastre = girar la cámara
let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || e.button !== 0) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
  downAt = null;
  if (moved > 8) return;
  const hit = pick(e);
  if (!hit) return;
  if (tool === 'shape') socket.emit('shape_tile', { q: hit.tile.q, r: hit.tile.r, delta: e.shiftKey ? -1 : 1 });
  else socket.emit('place_element', { q: hit.tile.q, r: hit.tile.r, type: tool });
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// ================================
// LOOP DE RENDER
// ================================
const projected = new THREE.Vector3();

function animate() {
  requestAnimationFrame(animate);

  // la esfera envolvente del InstancedMesh se calcula una sola vez: si la isla crece o
  // cambia de altura hay que recalcularla, o el raycaster y el culling ignoran los módulos nuevos
  if (animating.size) {
    hexes.computeBoundingSphere();
    fitShadowToWorld(hexes.boundingSphere.radius);
    for (const m of mists) m.material.uniforms.uIsland.value = hexes.boundingSphere.radius;
  }

  for (const t of animating) {
    t.cur += (t.h - t.cur) * PARAMS.lerp;
    if (Math.abs(t.h - t.cur) < 0.01) { t.cur = t.h; animating.delete(t); }
    writeMatrix(t);
    positionElement(t);
  }

  for (const t of tiles.values()) {
    if (t.obj && t.obj.scale.x < 1) t.obj.scale.setScalar(Math.min(1, t.obj.scale.x + 0.04));
  }

  const time = performance.now() / 1000;
  for (const [id, a] of animals) {
    a.pos.lerp(a.target, 0.08);
    a.obj.position.copy(a.pos);
    a.obj.position.y += Math.abs(Math.sin(time * 6 + id)) * 0.08; // saltitos
    if (a.obj.scale.x < 1) a.obj.scale.setScalar(Math.min(1, a.obj.scale.x + 0.05));
  }

  if (hovered) {
    const { x, z } = axialToWorld(hovered.q, hovered.r);
    hover.position.set(x, topY(hovered.cur) + 0.03, z);
  }

  for (const rc of remote.values()) {
    rc.mesh.position.lerp(rc.target, 0.25);
    projected.copy(rc.mesh.position).project(camera);
    rc.label.style.left = ((projected.x + 1) / 2) * innerWidth + 'px';
    rc.label.style.top = ((1 - projected.y) / 2) * innerHeight - 14 + 'px';
    rc.label.style.display = rc.mesh.visible && projected.z < 1 ? '' : 'none';
  }

  updateDayNight(performance.now());
  sea.material.uniforms.time.value = time * 0.5;
  for (const m of mists) m.material.uniforms.uTime.value = time;

  controls.update();
  composer.render();
}
animate();
