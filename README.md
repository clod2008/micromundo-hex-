# micromundo-hex-

Micromundo hexagonal colaborativo en tiempo real. Diplomatura en IA Aplicada al Arte Multimedial (UNA) · Módulo Código · Ejercicio 3.

Un diorama 3D compartido: una isla de módulos hexagonales que crece con un fractal (DLA) y evoluciona sola como autómata celular (agua, humedad, vegetación). Todos los conectados ven y modifican el mismo mundo en vivo: moldean el terreno y colocan semillas, manantiales, piedras y animales. Los animales tienen genoma, se reproducen y heredan su forma fractal. El mundo se frena al final de cada etapa hasta que se cumple un hito colaborativo. Tiene ciclo de día y noche compartido.

## Stack

- **Servidor:** Node.js + Express + Socket.io (`server.js`). El mundo vive en memoria; no hay base de datos, así que cada reinicio hace nacer un mundo nuevo.
- **Cliente:** Three.js (`public/`): hexágonos con `InstancedMesh`, modelos fractales procedurales, mar con reflejos, cielo, niebla y estrellas con shaders propios, bloom.

## Correr en local

```bash
npm install
npm start            # http://localhost:3000
```

Variables opcionales: `PORT`, `DAY_MS` (duración del día, por defecto 6 min), `START_PHASE` (0.25 = mediodía, 0.75 = medianoche), `TICK_MS`.

## Controles

| Tecla | Herramienta | Click |
|---|---|---|
| 1 | Moldear | levanta (Shift + click: cava) |
| 2 | Semilla | semilla → brote → arbusto → árbol |
| 3 | Manantial | fuente de agua |
| 4 | Piedra | bloquea pasto y animales |
| 5 | Animal | criatura fractal con genoma propio |

Arrastrar: orbitar · Rueda: zoom.

## Deploy en Render

Web Service · Build: `npm install` · Start: `npm start` (ver `render.yaml`).
