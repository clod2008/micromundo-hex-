// MICROMUNDO — shaders propios
// Cielo con degradé + halo de sol, y capas de niebla baja animada con ruido fractal (fbm).

import * as THREE from 'three';

// ================================
// CIELO — domo con degradé horizonte→cenit y halo alrededor del sol.
// El color del horizonte es el mismo que el de la niebla: la isla se funde con el cielo.
// ================================
export function createSky({ horizon, zenith, sunColor, sunDir, radius = 400 }) {
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uHorizon: { value: new THREE.Color(horizon) },
      uZenith: { value: new THREE.Color(zenith) },
      uSunColor: { value: new THREE.Color(sunColor) },
      uSunDir: { value: sunDir.clone().normalize() },
      uStars: { value: 0 },   // 0 de día, 1 de noche
      uHalo: { value: 1 },    // tamaño del halo: sol grande, luna chica
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = p.xyww; // siempre en el fondo
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uHorizon;
      uniform vec3 uZenith;
      uniform vec3 uSunColor;
      uniform vec3 uSunDir;
      uniform float uStars;
      uniform float uHalo;
      varying vec3 vDir;
      float hash3(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
      void main() {
        vec3 dir = normalize(vDir);
        float h = clamp(dir.y, 0.0, 1.0);
        vec3 col = mix(uHorizon, uZenith, pow(h, 0.55));
        float s = max(dot(dir, uSunDir), 0.0);
        col += uSunColor * (pow(s, 400.0 * uHalo) * 1.5 + pow(s, 24.0 * uHalo) * 0.25 + pow(s, 4.0 * uHalo) * 0.08);
        // estrellas: celdas al azar sobre la esfera, sólo de noche y lejos del horizonte
        vec3 cell = floor(dir * 220.0);
        float star = step(0.9975, hash3(cell)) * (0.5 + 0.5 * hash3(cell + 7.0));
        col += vec3(0.85, 0.9, 1.0) * star * uStars * smoothstep(0.02, 0.25, dir.y);
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 16), material);
  mesh.frustumCulled = false;
  return mesh;
}

// ================================
// NIEBLA BAJA — planos horizontales con ruido fbm que se desplaza lento.
// Se desvanece cerca de la cámara (para que no parezca una lámina) y lejos del centro.
// ================================
const NOISE_GLSL = /* glsl */ `
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x),
               mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  // fbm: la misma forma de ruido sumada a escalas cada vez más chicas (autosimilar)
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
    return v;
  }
`;

export function createMistLayer({ y, color, opacity, scale, speed, size = 320 }) {
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uScale: { value: scale },
      uSpeed: { value: speed },
      uIsland: { value: 15 }, // radio de la isla: la niebla se abre sobre ella
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying float vViewDist;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vec4 mv = viewMatrix * world;
        vViewDist = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uScale;
      uniform float uSpeed;
      uniform float uIsland;
      varying vec3 vWorld;
      varying float vViewDist;
      ${NOISE_GLSL}
      void main() {
        vec2 p = vWorld.xz * uScale;
        vec2 drift = vec2(uTime * uSpeed, uTime * uSpeed * 0.6);
        float n = fbm(p + drift + fbm(p * 0.5 - drift) * 1.5); // ruido deformado por ruido: volutas
        float a = smoothstep(0.45, 0.9, n) * uOpacity;
        float d = length(vWorld.xz);
        a *= mix(0.25, 1.0, smoothstep(uIsland * 0.7, uIsland * 1.6, d)); // claro sobre la isla, denso alrededor
        a *= smoothstep(3.0, 18.0, vViewDist);              // no tapar la cámara
        a *= 1.0 - smoothstep(110.0, 160.0, length(vWorld.xz)); // borde suave
        gl_FragColor = vec4(uColor, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = y;
  mesh.renderOrder = 5;
  return mesh;
}

// ================================
// PRISMAS — oclusión ambiental falsa: los costados se oscurecen hacia abajo
// y la cara de arriba queda plena (color por vértice × color por instancia).
// ================================
export function shadeHexGeometry(geo) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const ny = nor.getY(i);
    const y = pos.getY(i); // 0 = base, 1 = tope
    const k = ny > 0.9 ? 1.0 : ny < -0.9 ? 0.3 : 0.42 + 0.4 * Math.pow(y, 1.5);
    colors.set([k, k, k], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}
