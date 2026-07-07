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

interface InstancedState {
  entity: pc.Entity
  meshInstance: pc.MeshInstance
  vertexBuffer: pc.VertexBuffer
  matrixData: Float32Array
  count: number
}

let instancedStates: InstancedState[] = []

// Scratch variables for zero-allocation matrix transformations in loop
const scratchPos = new pc.Vec3()
const scratchRot = new pc.Quat()
const scratchScale = new pc.Vec3(0.8, 1.6, 0.8)
const scratchMat = new pc.Mat4()

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
}

function clearAgents() {
  if (!app) return
  for (const s of instancedStates) {
    s.entity.destroy()
    s.vertexBuffer.destroy()
  }
  instancedStates = []
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
    
    // Pre-allocate the vertex buffer holding the instanced transform matrices.
    // Each instance needs 16 floats (a 4x4 matrix).
    const matrixData = new Float32Array(count * 16)
    
    const format = pc.VertexFormat.getDefaultInstancingFormat(app.graphicsDevice)
    const vertexBuffer = new pc.VertexBuffer(app.graphicsDevice, format, count, {
      data: matrixData,
      usage: pc.BUFFER_DYNAMIC,
    } as any)

    meshInstance.setInstancing(vertexBuffer)
    meshInstance.instancingCount = 0

    instancedStates.push({
      entity,
      meshInstance,
      vertexBuffer,
      matrixData,
      count: 0
    })
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
  initInstancing(agentCount)

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
    if (wasmMemory && instancedStates.length > 0) {
      const posPtr = world.positions_ptr()
      const metaPtr = world.meta_ptr()

      const positions = new Float32Array(wasmMemory.buffer, posPtr, agentCount * 4)
      const meta = new Uint32Array(wasmMemory.buffer, metaPtr, agentCount * 3)

      // Reset count for all 5 states
      for (const s of instancedStates) {
        s.count = 0
      }

      for (let i = 0; i < agentCount; i++) {
        const idx = i * 4
        const x = positions[idx]
        const y = positions[idx + 1]
        const z = positions[idx + 2]

        const flags = meta[i * 3 + 1]
        
        // Find which state slot to map to:
        // 0: Walk (White), 1: Sleep (Blue), 2: Eat (Orange), 3: Social (Purple), 4: Wash (Green)
        let stateIdx = 0 
        if ((flags & 8) !== 0) {         // SLEEPING = 1 << 3 (Blue)
          stateIdx = 1
        } else if ((flags & 16) !== 0) {  // EATING = 1 << 4 (Orange)
          stateIdx = 2
        } else if ((flags & 2) !== 0) {   // SOCIALIZING = 1 << 1 (Purple)
          stateIdx = 3
        } else if ((flags & 4) !== 0) {   // IN_BUILDING/WASHING = 1 << 2 (Green)
          stateIdx = 4
        }

        const s = instancedStates[stateIdx]
        
        // Set transform matrix for this agent in its active state group
        scratchPos.set(x, y, z)
        scratchMat.setTRS(scratchPos, scratchRot, scratchScale)
        
        // Copy 16 matrix floats to the vertex buffer float array
        const matData = scratchMat.data
        const offset = s.count * 16
        for (let m = 0; m < 16; m++) {
          s.matrixData[offset + m] = matData[m]
        }
        s.count++
      }

      // Update PlayCanvas buffers for each state
      for (const s of instancedStates) {
        if (s.count > 0) {
          s.vertexBuffer.setData(s.matrixData as any)
          s.meshInstance.instancingCount = s.count
        } else {
          s.meshInstance.instancingCount = 0
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
