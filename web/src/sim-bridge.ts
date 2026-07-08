/* ─────────────────────────────────────────────────────────────────────────── *
 * sim-bridge.ts                                                               *
 * Wasm ↔ WebGPU zero-copy bridge.                                             *
 * Loads sim-core, exposes a reactive simulation loop, and owns the            *
 * SharedArrayBuffer / PlayCanvas render layer.                                *
 * ─────────────────────────────────────────────────────────────────────────── */

import { createSignal } from 'solid-js'
import * as pc from 'playcanvas'
import { initDb, snapshotTick, closeDb } from './db-bridge'

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

interface InstancedState {
  entity: pc.Entity
  meshInstance: pc.MeshInstance
  vertexBuffer: pc.VertexBuffer
  capacity: number
  count: number
}

let instancedStates: InstancedState[] = []
let buildingEntities: pc.Entity[] = []

// State-specific agent materials (P1 colors)
let walkMaterial: pc.StandardMaterial | null = null
let sleepMaterial: pc.StandardMaterial | null = null
let eatMaterial: pc.StandardMaterial | null = null
let socialMaterial: pc.StandardMaterial | null = null
let washMaterial: pc.StandardMaterial | null = null

// Building materials
let houseMaterial: pc.StandardMaterial | null = null
let workMaterial: pc.StandardMaterial | null = null
let foodMaterial: pc.StandardMaterial | null = null

// ── Wasm Loader ──────────────────────────────────────────────────────────────

async function loadWasm() {
  if (!wasmMod) {
    wasmMod = await import('@sim-core')
    // Initialise the wasm module (required for --target web bundles)
    await (wasmMod as any).default?.()
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
    } as any)
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
  ;(app.scene as any).ambientColor = new pc.Color(0.15, 0.2, 0.3)

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
  } as any)
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

  // Building materials
  houseMaterial = new pc.StandardMaterial()
  houseMaterial.diffuse = new pc.Color(0.2, 0.4, 0.6)
  houseMaterial.emissive = new pc.Color(0.05, 0.1, 0.2)
  houseMaterial.useLighting = true
  houseMaterial.update()

  workMaterial = new pc.StandardMaterial()
  workMaterial.diffuse = new pc.Color(0.5, 0.5, 0.5)
  workMaterial.emissive = new pc.Color(0.1, 0.1, 0.1)
  workMaterial.useLighting = true
  workMaterial.update()

  foodMaterial = new pc.StandardMaterial()
  foodMaterial.diffuse = new pc.Color(0.8, 0.3, 0.2)
  foodMaterial.emissive = new pc.Color(0.2, 0.05, 0.05)
  foodMaterial.useLighting = true
  foodMaterial.update()
}

function clearAgents() {
  if (!app) return
  for (const s of instancedStates) {
    s.entity.destroy()
    s.vertexBuffer.destroy()
  }
  instancedStates = []
}

function clearBuildings() {
  for (const e of buildingEntities) {
    e.destroy()
  }
  buildingEntities = []
}

function initInstancing(count: number) {
  if (!app || !walkMaterial || !sleepMaterial || !eatMaterial || !socialMaterial || !washMaterial) return

  clearAgents()

  const materials = [
    walkMaterial,
    sleepMaterial,
    eatMaterial,
    socialMaterial,
    washMaterial
  ]

  for (let i = 0; i < materials.length; i++) {
    const mat = materials[i]
    
    // Create the instanced parent entity
    const entity = new pc.Entity(`instanced-state-${i}`)
    entity.addComponent('render', {
      type: 'box',
    })
    entity.render!.material = mat as pc.Material
    
    // Set scale to 1. The per-instance transform matrices will carry the 
    // local agent scaling (0.8, 1.6, 0.8) and coordinates.
    entity.setLocalScale(1, 1, 1)
    app.root.addChild(entity)

    const meshInstance = entity.render!.meshInstances[0]
    
    // Start with a sensible initial capacity per state to avoid early re-allocations
    // e.g. 10% of total agent count, minimum 256
    const initialCapacity = Math.max(256, Math.ceil(count / 10))
    
    const format = pc.VertexFormat.getDefaultInstancingFormat(app.graphicsDevice)
    const vertexBuffer = new pc.VertexBuffer(app.graphicsDevice, format, initialCapacity, {
      usage: pc.BUFFER_DYNAMIC,
    } as any)

    meshInstance.setInstancing(vertexBuffer)
    meshInstance.instancingCount = 0

    instancedStates.push({
      entity,
      meshInstance,
      vertexBuffer,
      capacity: initialCapacity,
      count: 0
    })
  }
}

function initBuildings() {
  if (!app || !world || !wasmMemory || !houseMaterial || !workMaterial || !foodMaterial) return
  clearBuildings()
  
  const ptr = world.buildings_ptr()
  const count = world.buildings_count()
  const f32 = new Float32Array(wasmMemory.buffer, ptr, count * 5)
  const u32 = new Uint32Array(wasmMemory.buffer, ptr, count * 5)
  
  for (let i = 0; i < count; i++) {
    const x = f32[i * 5 + 0]
    const z = f32[i * 5 + 1]
    const w = f32[i * 5 + 2]
    const d = f32[i * 5 + 3]
    const btype = u32[i * 5 + 4]
    
    const entity = new pc.Entity(`building-${i}`)
    entity.addComponent('render', { type: 'box' })
    
    if (btype === 0) entity.render!.material = houseMaterial as pc.Material
    else if (btype === 1) entity.render!.material = workMaterial as pc.Material
    else entity.render!.material = foodMaterial as pc.Material
    
    // Make buildings 2 units tall, resting on the ground
    entity.setPosition(x, 1.0, z)
    entity.setLocalScale(w, 2.0, d)
    
    app!.root.addChild(entity)
    buildingEntities.push(entity)
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

  // Grab the WebAssembly.Memory handle via the canonical wasm_bindgen export
  wasmMemory = (mod as any).wasm_memory() as WebAssembly.Memory

  // 2. Initialise DuckDB-Wasm snapshot pipeline (non-blocking)
  initDb().catch(e => console.warn('[sim-bridge] DuckDB init failed:', e))

  // 3. Initialise the PlayCanvas renderer
  initPlayCanvas(canvas)
  clearAgents()
  initInstancing(agentCount)
  initBuildings()

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

    // ── FPS counter & UI Stats (update every 60 frames) ───────────────────
    frameCount++
    fpsAccum += dt
    if (frameCount % 60 === 0) {
      const fps = Math.round(1000 / (fpsAccum / 60))
      fpsAccum = 0

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

      setSimStats({
        tick: Number(tick),
        fps,
        agentCount,
        avgHunger,
        avgEnergy,
        avgSocial,
        avgHygiene,
      })

      // ── DuckDB snapshot (every 60 frames, async — non-blocking) ─────────
      if (wasmMemory) {
        snapshotTick(
          wasmMemory,
          Number(tick),
          agentCount,
          world.positions_ptr(),
          world.needs_ptr(),
          world.meta_ptr(),
        ).catch(e => console.warn('[sim-bridge] DuckDB snapshot failed:', e))
      }
    }

    // ── Zero-copy Wasm ↔ PlayCanvas update ──────────────────────────────────
    if (wasmMemory && instancedStates.length > 0) {
      try {
        for (let state = 0; state < 5; state++) {
          const s = instancedStates[state]
          const count = world.state_count(state)

          if (count > 0) {
            // Re-allocate larger VertexBuffer on the fly if state count exceeds capacity
            if (count > s.capacity) {
              s.capacity = Math.max(s.capacity * 2, count)
              s.vertexBuffer.destroy() // Clean up WebGL resource

              const format = pc.VertexFormat.getDefaultInstancingFormat(app!.graphicsDevice)
              s.vertexBuffer = new pc.VertexBuffer(app!.graphicsDevice, format, s.capacity, {
                usage: pc.BUFFER_DYNAMIC,
              } as any)
              s.meshInstance.setInstancing(s.vertexBuffer)
            }

            const ptr = world.state_matrices_ptr(state)
            // Create zero-copy view matching the current vertex buffer capacity exactly
            const matrixView = new Float32Array(wasmMemory.buffer, ptr, s.capacity * 16)
            s.vertexBuffer.setData(matrixView as any)
            s.meshInstance.instancingCount = count
          } else {
            s.meshInstance.instancingCount = 0
          }
        }
      } catch (err) {
        console.error("[sim-bridge] GPU buffer update failed:", err)
        stopSimulation()
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
  clearBuildings()
  closeDb().catch(() => {})
}

export function toggleSimulation(canvas: HTMLCanvasElement) {
  if (isRunning()) {
    stopSimulation()
  } else {
    startSimulation(canvas)
  }
}
