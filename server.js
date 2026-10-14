// MICROMUNDO — servidor
// Un único mundo hexagonal en memoria: crece con un fractal (DLA) por etapas,
// evoluciona con un autómata celular y lo habitan elementos que pone la gente.
// El mundo se frena al final de cada etapa hasta que se cumple un hito colaborativo.
// Los clientes solo dibujan y mandan acciones.

const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

// ================================
// PARÁMETROS
// ================================
const PARAMS = {
  port: process.env.PORT || 3000,
  tickMs: Number(process.env.TICK_MS) || 250, // un tick del mundo cada 250 ms
  maxTiles: 2500,       // techo absoluto de hexágonos
  growPerTick: 2,       // intentos de crecimiento fractal por tick
  hMin: -3,             // altura mínima (fondo marino)
  hMax: 10,             // altura máxima (cumbre)
  seaLevel: 0,          // h <= seaLevel → bajo el agua
  placeCooldownMs: 250, // anti-spam por persona
  dayLengthMs: Number(process.env.DAY_MS) || 6 * 60 * 1000, // un día completo (día + noche)
  animals: {
    max: 80,
    moveEvery: 4,       // ticks entre pasos
    startEnergy: 12,
    maxEnergy: 24,
    breedEnergy: 18,
  },
};

// Etapas: el mundo crece hasta `cap` hexágonos y se frena hasta cumplir el hito.
// `contributors`: cuántas personas distintas tienen que haber colocado algo en la etapa.
const STAGES = [
  { name: 'Isla naciente', cap: 60,  contributors: 2, needs: { tree: 3, spring: 1 } },
  { name: 'Primer bosque', cap: 180, contributors: 2, needs: { tree: 12, animal: 4 } },
  { name: 'Valles',        cap: 450, contributors: 3, needs: { tree: 30, animal: 10, spring: 3 } },
  { name: 'Archipiélago',  cap: 1000, contributors: 3, needs: { tree: 60, animal: 20, stone: 8 } },
  { name: 'Mundo abierto', cap: PARAMS.maxTiles, contributors: 0, needs: null }, // última: crece hasta el techo
];

const NEED_LABELS = { tree: 'árboles', spring: 'manantiales', animal: 'animales', stone: 'piedras' };

// ================================
// AZAR CON SEMILLA (cada mundo nace distinto)
// ================================
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seed = Math.floor(Math.random() * 2 ** 32);
const rand = mulberry32(seed);

// ================================
// GRILLA HEXAGONAL (coordenadas axiales q, r)
// ================================
const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
const key = (q, r) => q + ',' + r;
const hexDist = (q, r) => (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function hexRound(fq, fr) {
  const fs = -fq - fr;
  let q = Math.round(fq), r = Math.round(fr), s = Math.round(fs);
  const dq = Math.abs(q - fq), dr = Math.abs(r - fr), ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return [q, r];
}

// Elementos que viven sobre un hexágono (los animales son agentes aparte)
// semilla → brote → arbusto → árbol: la vegetación evoluciona por etapas
const EL = { none: 0, seed: 1, sprout: 2, bush: 3, tree: 4, spring: 5, stone: 6 };
const PLANT_NEXT = { [EL.seed]: EL.sprout, [EL.sprout]: EL.bush, [EL.bush]: EL.tree };
const PLANT_PREV = { [EL.tree]: EL.bush, [EL.bush]: EL.sprout, [EL.sprout]: EL.seed, [EL.seed]: EL.none };
const GROW_CHANCE = { [EL.seed]: 0.05, [EL.sprout]: 0.03, [EL.bush]: 0.02 };
const isPlant = (e) => e >= EL.seed && e <= EL.tree;

// ================================
// DÍA Y NOCHE — un reloj compartido: todos los clientes ven la misma hora
// fase 0 = amanecer (06:00), 0.25 = mediodía, 0.5 = atardecer, 0.75 = medianoche
// ================================
// el mundo nace a la mañana (START_PHASE permite arrancar a otra hora, útil para probar)
const worldStart = Date.now() - PARAMS.dayLengthMs * (Number(process.env.START_PHASE) || 0.04);
const dayPhase = () => (((Date.now() - worldStart) / PARAMS.dayLengthMs) % 1);
// 0 de noche, 1 de día, con transición en amanecer y atardecer
function daylight() {
  const elev = Math.sin(dayPhase() * Math.PI * 2);
  return clamp((elev + 0.1) / 0.4, 0, 1);
}

// tile = { q, r, h: altura, m: humedad 0..10, v: vegetación 0..10, e: elemento }
const tiles = new Map();
const dirty = new Set();   // hexágonos que cambiaron en este tick → se mandan como diff
let radius = 0;

function neighborsOf(t) {
  const out = [];
  for (const [dq, dr] of DIRS) {
    const n = tiles.get(key(t.q + dq, t.r + dr));
    if (n) out.push(n);
  }
  return out;
}

function addTile(q, r, h) {
  tiles.set(key(q, r), { q, r, h, m: 0, v: 0, e: EL.none });
  radius = Math.max(radius, hexDist(q, r));
  dirty.add(key(q, r));
}

const pack = (t) => [t.q, t.r, t.h, t.m, t.v, t.e];
const isLand = (t) => t && t.h > PARAMS.seaLevel;

// ================================
// CRECIMIENTO FRACTAL — DLA (Diffusion-Limited Aggregation)
// Un caminante nace lejos, vaga al azar y se pega al primer hexágono que toca.
// Las puntas atrapan más caminantes que los huecos → costa ramificada, tipo coral.
// ================================
function growStep() {
  const spawnR = radius + 3;
  const a = rand() * Math.PI * 2;
  const x = Math.sqrt(3) * spawnR * Math.cos(a);
  const z = Math.sqrt(3) * spawnR * Math.sin(a);
  let [q, r] = hexRound((Math.sqrt(3) / 3) * x - z / 3, (2 / 3) * z);

  for (let step = 0; step < 3000; step++) {
    // leve sesgo hacia el centro para que el caminante no se pierda
    let d;
    if (rand() < 0.25) {
      d = DIRS.reduce((best, dir) =>
        hexDist(q + dir[0], r + dir[1]) < hexDist(q + best[0], r + best[1]) ? dir : best);
    } else {
      d = DIRS[Math.floor(rand() * 6)];
    }
    q += d[0]; r += d[1];
    if (hexDist(q, r) > spawnR + 2) return; // se fue lejos: se descarta

    if (tiles.has(key(q, r))) return;
    const ns = neighborsOf({ q, r });
    if (ns.length > 0) {
      const avg = ns.reduce((s, n) => s + n.h, 0) / ns.length;
      // hacia afuera el terreno tiende a bajar: las ramas terminan en playas e islotes
      const h = clamp(Math.round(avg + (rand() - 0.53) * 2.2), PARAMS.hMin, PARAMS.hMax);
      addTile(q, r, h);
      return;
    }
  }
}

// ================================
// ECOSISTEMA — autómata celular sobre los 6 vecinos
// Humedad: el mar y los manantiales mojan, y se propaga perdiendo fuerza con la altura.
// Pasto (v): crece donde hay humedad, se seca donde falta.
// Plantas: semilla → brote → arbusto → árbol si hay agua; retroceden con sequía.
// Los árboles siembran a sus vecinos.
// ================================
function ecologyStep() {
  const light = 0.15 + 0.85 * daylight(); // de noche la vegetación casi no crece
  for (const t of tiles.values()) {
    const before = t.m * 1000 + t.v * 10 + t.e;
    const ns = neighborsOf(t);

    if (t.h <= PARAMS.seaLevel) {
      t.m = 10; t.v = 0; t.e = EL.none; // bajo el agua no sobrevive nada
    } else if (t.e === EL.spring) {
      t.m = 10;
      if (t.v < 10 && rand() < 0.12 * light) t.v++;
    } else {
      let best = ns.length < 6 ? 8 : 0; // borde de la isla = toca el mar
      for (const n of ns) best = Math.max(best, n.m);
      t.m = clamp(best - 1 - Math.floor(t.h / 3), 0, 10);

      if (t.e !== EL.stone) {
        if (t.m >= 4 && t.v < 10 && rand() < 0.12 * light) t.v++;
        else if (t.m < 3 && t.v > 0 && rand() < 0.08) t.v--;
      }

      if (isPlant(t.e)) {
        if (t.m >= 4 && PLANT_NEXT[t.e] && rand() < GROW_CHANCE[t.e] * light) t.e = PLANT_NEXT[t.e];
        else if (t.m < 2 && rand() < 0.02) t.e = PLANT_PREV[t.e];

        if (t.e === EL.tree && rand() < 0.008) {
          const n = ns[Math.floor(rand() * ns.length)];
          if (n && isLand(n) && n.e === EL.none && n.v >= 3) {
            n.e = EL.seed;
            dirty.add(key(n.q, n.r));
          }
        }
      }
    }

    if (t.m * 1000 + t.v * 10 + t.e !== before) dirty.add(key(t.q, t.r));
  }
}

// ================================
// ANIMALES — agentes que buscan pasto, comen, se reproducen y mueren de hambre
// ================================
const animals = new Map(); // id → { id, q, r, energy, g: genoma }
let nextAnimalId = 1;
let tickCount = 0;

// GENOMA — los valores con que se construye el fractal de cada animal (sphereflake).
// [mín, máx] de cada gen; `int` = se redondea.
const GENES = {
  size:    [0.18, 0.4],   // radio del cuerpo
  ratio:   [0.28, 0.55],  // tamaño de cada hija respecto de la madre
  depth:   [1, 3, 'int'], // niveles de recursión
  arms:    [2, 6, 'int'], // esferas hijas por nivel
  spread:  [-0.6, 1.1],   // inclinación de los brazos (negativo = hacia abajo, tipo patas)
  stretch: [0.7, 1.6],    // alargamiento del cuerpo
  hue:     [0, 1],        // color
};

function randomGenome() {
  const g = { seed: Math.floor(rand() * 2 ** 31) };
  for (const [k, [min, max, int]] of Object.entries(GENES)) {
    const v = min + rand() * (max - min);
    g[k] = int ? Math.round(v) : v;
  }
  return g;
}

// Cría: cada gen sale de uno de los padres al azar, con una mutación chica (~8% del rango)
function inheritGenome(a, b) {
  const g = { seed: Math.floor(rand() * 2 ** 31) };
  for (const [k, [min, max, int]] of Object.entries(GENES)) {
    let v = (rand() < 0.5 ? a : b)[k] + (rand() - 0.5) * 0.16 * (max - min);
    if (k === 'hue') v = (v + 1) % 1; // el color da la vuelta
    v = clamp(v, min, max);
    g[k] = int ? Math.round(v) : v;
  }
  return g;
}

function addAnimal(q, r, energy, g = randomGenome()) {
  if (animals.size >= PARAMS.animals.max) return null;
  const a = { id: nextAnimalId++, q, r, energy, g };
  animals.set(a.id, a);
  return a;
}

function animalStep() {
  const night = daylight() < 0.2;
  const every = PARAMS.animals.moveEvery * (night ? 3 : 1); // de noche duermen: se mueven y gastan menos
  if (tickCount % every !== 0) return;
  const occupied = new Map();
  for (const a of animals.values()) occupied.set(key(a.q, a.r), a);

  for (const a of [...animals.values()]) {
    const here = tiles.get(key(a.q, a.r));
    if (!isLand(here)) { animals.delete(a.id); continue; } // le cavaron el piso: se ahoga

    // comer
    if (here.v > 0) {
      here.v--;
      a.energy = Math.min(PARAMS.animals.maxEnergy, a.energy + 2);
      dirty.add(key(here.q, here.r));
    }
    a.energy -= 1;
    if (a.energy <= 0) { animals.delete(a.id); continue; }

    // moverse hacia el vecino con más pasto (con algo de azar)
    const options = neighborsOf(here).filter((n) => isLand(n) && n.e !== EL.stone && n.h - here.h <= 2);
    if (options.length) {
      options.sort((x, y) => (y.v + rand() * 4) - (x.v + rand() * 4));
      const to = options[0];
      const mate = occupied.get(key(to.q, to.r));
      if (mate && mate !== a) {
        // encuentro: si los dos están bien alimentados, nace una cría
        if (a.energy >= PARAMS.animals.breedEnergy && mate.energy >= PARAMS.animals.breedEnergy && rand() < 0.5) {
          a.energy -= 6; mate.energy -= 6;
          addAnimal(here.q, here.r, PARAMS.animals.startEnergy, inheritGenome(a.g, mate.g));
        }
      } else {
        occupied.delete(key(a.q, a.r));
        a.q = to.q; a.r = to.r;
        occupied.set(key(a.q, a.r), a);
      }
    }
  }
}

// ================================
// ETAPAS E HITOS COLABORATIVOS
// ================================
let stageIndex = 0;
let stageContributors = new Set(); // quiénes colocaron algo en esta etapa

function countWorld() {
  const c = { tree: 0, spring: 0, stone: 0, animal: animals.size };
  for (const t of tiles.values()) {
    if (t.e === EL.tree) c.tree++;
    else if (t.e === EL.spring) c.spring++;
    else if (t.e === EL.stone) c.stone++;
  }
  return c;
}

function progress() {
  const stage = STAGES[stageIndex];
  const counts = countWorld();
  const needs = stage.needs
    ? Object.entries(stage.needs).map(([k, need]) => ({ label: NEED_LABELS[k], have: counts[k], need }))
    : [];
  return {
    stage: stageIndex + 1,
    stages: STAGES.length,
    name: stage.name,
    tiles: tiles.size,
    cap: stage.cap,
    halted: tiles.size >= stage.cap && !!stage.needs,
    needs,
    contributors: { have: stageContributors.size, need: stage.contributors },
    animals: animals.size,
  };
}

function checkMilestone() {
  const stage = STAGES[stageIndex];
  if (!stage.needs || tiles.size < stage.cap) return;
  const counts = countWorld();
  const ok = Object.entries(stage.needs).every(([k, need]) => counts[k] >= need)
    && stageContributors.size >= stage.contributors;
  if (!ok) return;

  stageIndex++;
  stageContributors = new Set();
  const next = STAGES[stageIndex];
  console.log(`Hito cumplido → etapa ${stageIndex + 1}: ${next.name}`);
  io.emit('milestone', { stage: stageIndex + 1, name: next.name, completed: stage.name });
}

addTile(0, 0, 4); // el mundo nace de un solo hexágono

// ================================
// SERVIDOR
// ================================
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const cursors = new Map(); // socket.id → { id, color, x, y, z }
let hueCursor = Math.random() * 360;
const GENE_KEYS = ['seed', ...Object.keys(GENES)];
const packAnimals = () => [...animals.values()].map((a) => [a.id, a.q, a.r, GENE_KEYS.map((k) => +a.g[k].toFixed(3))]);

io.on('connection', (socket) => {
  hueCursor = (hueCursor + 137.5) % 360; // ángulo áureo: colores bien separados entre sí
  const cursor = { id: socket.id, color: `hsl(${Math.round(hueCursor)}, 75%, 60%)`, x: 0, y: -999, z: 0 };
  cursors.set(socket.id, cursor);
  let lastPlace = 0;

  socket.emit('world_init', {
    seed,
    you: { id: socket.id, color: cursor.color },
    tiles: [...tiles.values()].map(pack),
    animals: packAnimals(),
    cursors: [...cursors.values()].filter((c) => c.id !== socket.id),
    progress: progress(),
    time: { start: worldStart, dayLengthMs: PARAMS.dayLengthMs, serverNow: Date.now() },
  });

  // Moldear terreno: levantar (+1) o cavar (-1) un hexágono
  socket.on('shape_tile', (data) => {
    if (!data) return;
    const t = tiles.get(key(data.q, data.r));
    const d = Math.sign(Number(data.delta));
    if (!t || !d) return;
    t.h = clamp(t.h + d, PARAMS.hMin, PARAMS.hMax);
    dirty.add(key(t.q, t.r));
  });

  // Colocar un elemento: semilla, manantial, piedra o animal (solo sobre tierra firme y libre)
  socket.on('place_element', (data) => {
    const now = Date.now();
    if (!data || now - lastPlace < PARAMS.placeCooldownMs) return;
    const t = tiles.get(key(data.q, data.r));
    if (!isLand(t)) return;

    if (data.type === 'animal') {
      if (t.e === EL.stone || !addAnimal(t.q, t.r, PARAMS.animals.startEnergy)) return;
    } else {
      const e = { seed: EL.seed, spring: EL.spring, stone: EL.stone }[data.type];
      if (!e || t.e !== EL.none) return;
      t.e = e;
      if (e === EL.stone) t.v = 0;
      dirty.add(key(t.q, t.r));
    }
    lastPlace = now;
    stageContributors.add(socket.id);
  });

  // Cursor en el espacio 3D (cada uno tiene su cámara, así que la pantalla no sirve de referencia)
  socket.on('cursor_move', (p) => {
    if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return;
    cursor.x = p.x; cursor.y = p.y; cursor.z = p.z;
    socket.broadcast.volatile.emit('cursor', cursor);
  });

  socket.on('disconnect', () => {
    cursors.delete(socket.id);
    io.emit('client_disconnected', socket.id);
  });
});

let lastProgress = '';

setInterval(() => {
  tickCount++;
  const cap = Math.min(STAGES[stageIndex].cap, PARAMS.maxTiles);
  for (let i = 0; i < PARAMS.growPerTick && tiles.size < cap; i++) growStep();
  ecologyStep();
  animalStep();
  checkMilestone();

  if (dirty.size > 0) {
    io.emit('world_diff', [...dirty].map((k) => pack(tiles.get(k))));
    dirty.clear();
  }
  if (tickCount % PARAMS.animals.moveEvery === 0) io.emit('animals', packAnimals());

  const p = JSON.stringify(progress());
  if (p !== lastProgress) { lastProgress = p; io.emit('progress', JSON.parse(p)); }
}, PARAMS.tickMs);

server.listen(PARAMS.port, () => {
  console.log(`Micromundo en http://localhost:${PARAMS.port} — semilla ${seed}`);
});
