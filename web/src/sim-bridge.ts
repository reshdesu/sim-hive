/* ─────────────────────────────────────────────────────────────────────────── *
 * sim-bridge.ts                                                               *
 * Wasm ↔ WebGPU zero-copy bridge.                                             *
 * Loads sim-core, exposes a reactive simulation loop, and owns the            *
 * SharedArrayBuffer / PlayCanvas render layer.                                *
 * ─────────────────────────────────────────────────────────────────────────── */

import { createSignal } from 'solid-js'
import * as pc from 'playcanvas'

// ── Types ────────────────────────────────────────────────────────────────────

export interface SimStats {
  tick: number
  fps: number
  agentCount: number
  avgHunger: number
  avgEnergy: number
  avgSocial: number
  avgHygiene: number
}

// ── Globals ──────────────────────────────────────────────────────────────────

let wasmMod: typeof import('@sim-core') | null = null
let wasmMemory: WebAssembly.Memory | null = null

let world: any = null
let rafId: number | null = null
let lastTime = 0
let frameCount = 0
let fpsAccum = 0

// PlayCanvas application state
let app: pc.Application | null = null
let agentEntities: pc.Entity[] = []

// State-specific agent materials (P1 colors)
let walkMaterial: pc.StandardMaterial | null = null
let sleepMaterial: pc.StandardMaterial | null = null
let eatMaterial: pc.StandardMaterial | null = null
let socialMaterial: pc.StandardMaterial | null = null
let washMaterial: pc.StandardMaterial | null = null

// ── Wasm Loader ──────────────────────────────────────────────────────────────

async function loadWasm() {
  if (!wasmMod) {
    wasmMod = await import('@sim-core')
    const exports = await (wasmMod as any).default?.()
    if (exports && exports.memory) {
      wasmMemory = exports.memory
    }
  }
  return wasmMod
}

// ── PlayCanvas Setup ─────────────────────────────────────────────────────────

function initPlayCanvas(canvas: HTMLCanvasElement) {
  if (app) return

  // 1. Create the WebGL2 context directly to pass to PlayCanvas.
  // This avoids double-getContext calls which can lock canvas context attributes.
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    depth: true,
    stencil: true,
    antialias: false,
    premultipliedAlpha: true,
  })

  if (!gl) {
    const gl1 = canvas.getContext('webgl') || canvas.getContext('experimental-webgl')
    if (gl1) {
      throw new Error('Your browser supports WebGL1, but WebGL2 is required for this simulation. Please check your browser flags or settings.')
    } else {
      throw new Error('WebGL is not supported by your browser. Please enable hardware acceleration in your browser settings.')
    }
  }

  try {
    // Create playcanvas application using our pre-constructed WebGL2 context
    app = new pc.Application(canvas, {
      gl: gl,
      elementInput: new pc.ElementInput(canvas),
      keyboard: new pc.Keyboard(window),
      mouse: new pc.Mouse(canvas),
      touch: new pc.TouchDevice(canvas),
    })
  } catch (err: any) {
    app = null
    throw new Error(`Failed to initialize PlayCanvas: ${err?.message || err}`)
  }

  // Configure viewport
  app.setCanvasFillMode(pc.FILLMODE_NONE)
  app.setCanvasResolution(pc.RESOLUTION_AUTO)
  app.start()

  // Handle window resizing
  window.addEventListener('resize', () => {
    app?.resizeCanvas()
  })

  // 1. Set up Camera
  const camera = new pc.Entity('camera')
  camera.addComponent('camera', {
    clearColor: new pc.Color(0.06, 0.08, 0.1, 1.0), // Deep space blue background
    farClip: 1000,
  })
  camera.setPosition(100, 110, 220)
  camera.lookAt(100, 0, 100)
  app.root.addChild(camera)

  // 2. Set up Directional Light
  const light = new pc.Entity('light')
  light.addComponent('light', {
    type: 'directional',
    color: new pc.Color(0.8, 0.9, 1.0),
    intensity: 1.5,
  })
  light.setEulerAngles(45, 135, 0)
  app.root.addChild(light)

  // Ambient lighting
  app.scene.ambientColor = new pc.Color(0.15, 0.2, 0.3)

  // 3. Set up Ground grid boundary (200x200 matching Rust simulation space)
  // Create a procedural grid texture to give coordinate reference
  const gridCanvas = document.createElement('canvas')
  gridCanvas.width = 128
  gridCanvas.height = 128
  const gridCtx = gridCanvas.getContext('2d')
  if (gridCtx) {
    // Background: dark space blue
    gridCtx.fillStyle = '#090d16'
    gridCtx.fillRect(0, 0, 128, 128)
    // Outer border grid line (subtle grey)
    gridCtx.strokeStyle = 'rgba(255, 255, 255, 0.05)'
    gridCtx.lineWidth = 1
    gridCtx.strokeRect(0, 0, 128, 128)
    // Inner crosshairs (glowing cyan)
    gridCtx.strokeStyle = 'rgba(0, 204, 255, 0.12)'
    gridCtx.lineWidth = 1
    gridCtx.beginPath()
    gridCtx.moveTo(64, 0)
    gridCtx.lineTo(64, 128)
    gridCtx.moveTo(0, 64)
    gridCtx.lineTo(128, 64)
    gridCtx.stroke()
  }

  const gridTexture = new pc.Texture(app.graphicsDevice, {
    width: 128,
    height: 128,
    format: pc.PIXELFORMAT_RGBA8,
    autoMipmap: true,
    minFilter: pc.FILTER_LINEAR_MIPMAP_LINEAR,
    magFilter: pc.FILTER_LINEAR,
    addressU: pc.ADDRESS_REPEAT,
    addressV: pc.ADDRESS_REPEAT,
  })
  gridTexture.setSource(gridCanvas)

  const groundMaterial = new pc.StandardMaterial()
  groundMaterial.diffuseMap = gridTexture
  groundMaterial.diffuseMapTiling = new pc.Vec2(20, 20) // Tile 20x20 times for a 200x200 grid scale
  groundMaterial.specular = new pc.Color(0.0, 0.0, 0.0)
  groundMaterial.useLighting = true
  groundMaterial.update()

  const ground = new pc.Entity('ground')
  ground.addComponent('render', {
    type: 'plane',
  })
  ground.setPosition(100, -0.5, 100)
  ground.setLocalScale(20, 1, 20) // scale from default 10x10 plane to 200x200
  ground.render!.material = groundMaterial
  app.root.addChild(ground)

  // 4. Create state-specific materials for agents, matching the UI vital bars
  
  // Normal / Wandering state: neon neutral white (does not match any vital color)
  walkMaterial = new pc.StandardMaterial()
  walkMaterial.diffuse = new pc.Color(0.9, 0.9, 0.9)
  walkMaterial.emissive = new pc.Color(0.5, 0.5, 0.5)
  walkMaterial.useLighting = true
  walkMaterial.update()

  // Sleeping state: neon sky blue (matches Energy bar)
  sleepMaterial = new pc.StandardMaterial()
  sleepMaterial.diffuse = new pc.Color(0.26, 0.73, 0.94)
  sleepMaterial.emissive = new pc.Color(0.13, 0.36, 0.47)
  sleepMaterial.useLighting = true
  sleepMaterial.update()

  // Eating state: neon orange (matches Hunger bar)
  eatMaterial = new pc.StandardMaterial()
  eatMaterial.diffuse = new pc.Color(0.96, 0.52, 0.24)
  eatMaterial.emissive = new pc.Color(0.48, 0.26, 0.12)
  eatMaterial.useLighting = true
  eatMaterial.update()

  // Socializing state: neon violet purple (matches Social bar)
  socialMaterial = new pc.StandardMaterial()
  socialMaterial.diffuse = new pc.Color(0.74, 0.39, 0.91)
  socialMaterial.emissive = new pc.Color(0.37, 0.19, 0.45)
  socialMaterial.useLighting = true
  socialMaterial.update()

  // Washing / Hygiene state: neon mint green (matches Hygiene bar)
  washMaterial = new pc.StandardMaterial()
  washMaterial.diffuse = new pc.Color(0.23, 0.87, 0.55)
  washMaterial.emissive = new pc.Color(0.11, 0.43, 0.27)
  washMaterial.useLighting = true
  washMaterial.update()
}

function clearAgents() {
  if (!app) return
  for (const entity of agentEntities) {
    entity.destroy()
  }
  agentEntities = []
}

function spawnAgentEntities(count: number) {
  if (!app || !walkMaterial) return

  for (let i = 0; i < count; i++) {
    const agent = new pc.Entity(`agent-${i}`)
    agent.addComponent('render', {
      type: 'box',
    })
    agent.setLocalScale(0.8, 1.6, 0.8) // human aspect ratio
    agent.render!.material = walkMaterial
    app.root.addChild(agent)
    agentEntities.push(agent)
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export const [simStats, setSimStats] = createSignal<SimStats>({
  tick: 0,
  fps: 0,
  agentCount: 0,
  avgHunger: 0.9,
  avgEnergy: 0.9,
  avgSocial: 0.7,
  avgHygiene: 0.9,
})

export const [isRunning, setIsRunning] = createSignal(false)

/**
 * Initialise the simulation with `agentCount` agents and attach it to
 * the given canvas element (PlayCanvas renderer).
 */
export async function startSimulation(canvas: HTMLCanvasElement, agentCount = 1024) {
  const mod = await loadWasm()

  // 1. Initialise the Wasm ECS World
  world = mod.init_simulation(agentCount)

  // 2. Initialise the PlayCanvas renderer
  initPlayCanvas(canvas)
  clearAgents()
  spawnAgentEntities(agentCount)

  setSimStats({
    tick: 0,
    fps: 0,
    agentCount: world.agent_count(),
    avgHunger: 0.9,
    avgEnergy: 0.9,
    avgSocial: 0.7,
    avgHygiene: 0.9,
  })
  setIsRunning(true)

  function loop(now: number) {
    const dt = now - lastTime
    lastTime = now

    // ── Simulation tick ────────────────────────────────────────────────────
    const tick = world.tick()

    // ── Read Needs from Wasm memory & Compute aggregates ────────────────────
    let avgHunger = 0.9
    let avgEnergy = 0.9
    let avgSocial = 0.7
    let avgHygiene = 0.9

    if (wasmMemory) {
      const needsPtr = world.needs_ptr()
      const needs = new Float32Array(wasmMemory.buffer, needsPtr, agentCount * 4)

      let sumHunger = 0
      let sumEnergy = 0
      let sumSocial = 0
      let sumHygiene = 0

      for (let i = 0; i < agentCount; i++) {
        const idx = i * 4
        sumHunger += needs[idx]
        sumEnergy += needs[idx + 1]
        sumSocial += needs[idx + 2]
        sumHygiene += needs[idx + 3]
      }

      avgHunger = sumHunger / agentCount
      avgEnergy = sumEnergy / agentCount
      avgSocial = sumSocial / agentCount
      avgHygiene = sumHygiene / agentCount
    }

    // ── FPS counter (update every 60 frames) ──────────────────────────────
    frameCount++
    fpsAccum += dt
    if (frameCount % 60 === 0) {
      const fps = Math.round(1000 / (fpsAccum / 60))
      fpsAccum = 0
      setSimStats({
        tick: Number(tick),
        fps,
        agentCount,
        avgHunger,
        avgEnergy,
        avgSocial,
        avgHygiene,
      })
    }

    // ── Zero-copy Wasm ↔ PlayCanvas update ──────────────────────────────────
    if (wasmMemory && agentEntities.length > 0) {
      const posPtr = world.positions_ptr()
      const metaPtr = world.meta_ptr()

      // Create views over the Wasm memory buffer directly (no copy)
      // Positions: 4 floats per agent (x, y, z, _pad)
      const positions = new Float32Array(wasmMemory.buffer, posPtr, agentCount * 4)
      // Meta: 3 u32s per agent (entity_id, archetype_flags, age/household)
      const meta = new Uint32Array(wasmMemory.buffer, metaPtr, agentCount * 3)

      for (let i = 0; i < agentCount; i++) {
        // 1. Update Position
        const idx = i * 4
        const x = positions[idx]
        const y = positions[idx + 1]
        const z = positions[idx + 2]
        agentEntities[i].setPosition(x, y, z)

        // 2. Update Material (Color based on state flags)
        const flags = meta[i * 3 + 1]
        let mat = walkMaterial

        if ((flags & 8) !== 0) {         // SLEEPING = 1 << 3 (Blue)
          mat = sleepMaterial
        } else if ((flags & 16) !== 0) {  // EATING = 1 << 4 (Orange)
          mat = eatMaterial
        } else if ((flags & 2) !== 0) {   // SOCIALIZING = 1 << 1 (Pink/Purple)
          mat = socialMaterial
        } else if ((flags & 4) !== 0) {   // IN_BUILDING/WASHING = 1 << 2 (Green)
          mat = washMaterial
        }

        if (agentEntities[i].render!.material !== mat) {
          agentEntities[i].render!.material = mat
        }
      }
    }

    rafId = requestAnimationFrame(loop)
  }

  lastTime = performance.now()
  rafId = requestAnimationFrame(loop)
}

export function stopSimulation() {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  setIsRunning(false)
  clearAgents()
}

export function toggleSimulation(canvas: HTMLCanvasElement) {
  if (isRunning()) {
    stopSimulation()
  } else {
    startSimulation(canvas)
  }
}
