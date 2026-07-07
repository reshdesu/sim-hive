/* ─────────────────────────────────────────────────────────────────────────── *
 * App.tsx — Sim Hive root component                                            *
 * ─────────────────────────────────────────────────────────────────────────── */

import { createSignal, onCleanup, type Component } from 'solid-js'
import { simStats, isRunning, startSimulation, stopSimulation } from './sim-bridge'

// ── Constants ────────────────────────────────────────────────────────────────
const AGENT_COUNT = 1024

const ROADMAP = [
  { priority: 'p0', label: 'Rust ECS crate (wasm-pack)', done: true },
  { priority: 'p0', label: 'COEP/COOP headers (SharedArrayBuffer)', done: true },
  { priority: 'p1', label: 'Wasm memory → PlayCanvas instanced draw', done: false },
  { priority: 'p1', label: 'Archetype storage + movement system', done: false },
  { priority: 'p2', label: 'DuckDB-Wasm + Arrow IPC snapshot', done: false },
  { priority: 'p3', label: 'BehaviorDecisionSystem (FSM)', done: false },
  { priority: 'p4', label: 'Population dashboard (SolidJS)', done: false },
]

// ── App ───────────────────────────────────────────────────────────────────────
const App: Component = () => {
  let canvasRef!: HTMLCanvasElement

  const [agentInput, setAgentInput] = createSignal(AGENT_COUNT)
  const [wasmError, setWasmError] = createSignal<string | null>(null)

  // ── Wasm lifecycle ─────────────────────────────────────────────────────────
  async function handleStart() {
    try {
      await startSimulation(canvasRef, agentInput())
    } catch (e: any) {
      setWasmError(String(e?.message ?? e))
      console.error('[sim-hive] Wasm init failed:', e)
    }
  }

  function handleStop() {
    stopSimulation()
  }

  onCleanup(() => stopSimulation())

  // ── Derived display helpers ────────────────────────────────────────────────
  const stats = () => simStats()

  return (
    <div class="layout fade-in">

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header class="header">
        <div class="header__logo">
          <div class="header__hexagon" aria-hidden="true" />
          <div>
            <div class="header__title">Sim Hive</div>
            <div class="header__subtitle">Population Simulator</div>
          </div>
        </div>

        <div class="header__spacer" />

        <span class={`chip ${isRunning() ? 'chip--active' : ''}`}>
          <span class="chip__dot" />
          {isRunning() ? 'Simulating' : 'Idle'}
        </span>

        <span class="chip">
          <span style={{ color: 'var(--primary)', 'font-size': '0.8em' }}>⬡</span>
          PlayCanvas
        </span>

        <span class="chip">
          <span style={{ color: 'var(--accent)', 'font-size': '0.8em' }}>⚡</span>
          Rust / Wasm
        </span>
      </header>

      {/* ── Canvas ──────────────────────────────────────────────────────── */}
      <main class="canvas-area" id="sim-viewport">
        <canvas
          ref={canvasRef!}
          class="sim-canvas"
          id="sim-canvas"
          aria-label="Simulation viewport"
        />

        {/* Visual overlays */}
        <div class="canvas-grid" aria-hidden="true" />
        <div class="canvas-scanlines" aria-hidden="true" />

        {/* Placeholder shown before sim starts */}
        {!isRunning() && (
          <div class="canvas-placeholder" aria-hidden="true">
            <div class="canvas-placeholder__hex" />
            <span class="canvas-placeholder__text">
              {wasmError()
                ? `⚠ ${wasmError()}`
                : 'Press Start to launch simulation'}
            </span>
          </div>
        )}

        {/* Floating controls */}
        <div class="canvas-controls" role="toolbar" aria-label="Simulation controls">
          <label style={{ 'font-size': '0.72rem', color: 'var(--text-mid)' }}>
            Agents:
          </label>
          <input
            id="agent-count"
            type="number"
            min={64}
            max={8192}
            step={64}
            value={agentInput()}
            disabled={isRunning()}
            onInput={(e) => setAgentInput(Number((e.target as HTMLInputElement).value))}
            style={{
              width: '72px',
              background: 'var(--bg-2)',
              border: '1px solid var(--glass-border)',
              'border-radius': 'var(--radius-sm)',
              color: 'var(--text-hi)',
              padding: '4px 8px',
              'font-family': 'var(--font-mono)',
              'font-size': '0.78rem',
            }}
          />

          {!isRunning()
            ? (
              <button id="btn-start" class="btn btn--primary" onClick={handleStart}>
                ▶ Start
              </button>
            )
            : (
              <button id="btn-stop" class="btn btn--ghost" onClick={handleStop}>
                ■ Stop
              </button>
            )
          }
        </div>
      </main>

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside class="sidebar" aria-label="Simulation dashboard">

        {/* Live stats */}
        <section class="panel" aria-labelledby="panel-stats-title">
          <div id="panel-stats-title" class="panel__title">Live stats</div>
          <div class="stat-grid">
            <div class="stat-card">
              <div class="stat-card__label">Tick</div>
              <div class="stat-card__value stat-card__value--primary" id="stat-tick">
                {stats().tick.toLocaleString()}
              </div>
            </div>
            <div class="stat-card">
              <div class="stat-card__label">FPS</div>
              <div class="stat-card__value stat-card__value--accent" id="stat-fps">
                {stats().fps}
              </div>
            </div>
            <div class="stat-card">
              <div class="stat-card__label">Agents</div>
              <div class="stat-card__value" id="stat-agents">
                {stats().agentCount.toLocaleString()}
              </div>
            </div>
            <div class="stat-card">
              <div class="stat-card__label">Engine</div>
              <div class="stat-card__value" style={{ 'font-size': '0.72rem', color: 'var(--text-mid)' }}>
                Rust/Wasm
              </div>
            </div>
          </div>
        </section>

        {/* Population vitals */}
        <section class="panel" aria-labelledby="panel-vitals-title">
          <div id="panel-vitals-title" class="panel__title">Population vitals</div>

          <div class="vital-row">
            <div class="vital-row__label">
              <span>Hunger</span>
              <span id="vital-hunger-val" style={{ 'font-family': 'var(--font-mono)', 'font-size': '0.65rem' }}>
                {Math.round(stats().avgHunger * 100)}%
              </span>
            </div>
            <div class="vital-bar" role="progressbar" aria-label="hunger">
              <div class="vital-bar__fill vital-bar__fill--hunger" style={{ width: `${stats().avgHunger * 100}%` }} />
            </div>
          </div>

          <div class="vital-row">
            <div class="vital-row__label">
              <span>Energy</span>
              <span id="vital-energy-val" style={{ 'font-family': 'var(--font-mono)', 'font-size': '0.65rem' }}>
                {Math.round(stats().avgEnergy * 100)}%
              </span>
            </div>
            <div class="vital-bar" role="progressbar" aria-label="energy">
              <div class="vital-bar__fill vital-bar__fill--energy" style={{ width: `${stats().avgEnergy * 100}%` }} />
            </div>
          </div>

          <div class="vital-row">
            <div class="vital-row__label">
              <span>Social</span>
              <span id="vital-social-val" style={{ 'font-family': 'var(--font-mono)', 'font-size': '0.65rem' }}>
                {Math.round(stats().avgSocial * 100)}%
              </span>
            </div>
            <div class="vital-bar" role="progressbar" aria-label="social">
              <div class="vital-bar__fill vital-bar__fill--social" style={{ width: `${stats().avgSocial * 100}%` }} />
            </div>
          </div>

          <div class="vital-row">
            <div class="vital-row__label">
              <span>Hygiene</span>
              <span id="vital-hygiene-val" style={{ 'font-family': 'var(--font-mono)', 'font-size': '0.65rem' }}>
                {Math.round(stats().avgHygiene * 100)}%
              </span>
            </div>
            <div class="vital-bar" role="progressbar" aria-label="hygiene">
              <div class="vital-bar__fill vital-bar__fill--hygiene" style={{ width: `${stats().avgHygiene * 100}%` }} />
            </div>
          </div>

          <p style={{ 'font-size': '0.62rem', color: 'var(--text-lo)', 'margin-top': '8px' }}>
            Live aggregates via Wasm memory bridge
          </p>
        </section>

        {/* Stack info */}
        <section class="panel" aria-labelledby="panel-stack-title">
          <div id="panel-stack-title" class="panel__title">Tech stack</div>
          {[
            { label: 'Logic',      value: 'Rust → Wasm (wasm-pack)' },
            { label: 'Rendering',  value: 'PlayCanvas WebGPU' },
            { label: 'State',      value: 'DuckDB-Wasm (P2)' },
            { label: 'UI',         value: 'SolidJS' },
            { label: 'Pattern',    value: 'ECS / Data-Oriented' },
          ].map(row => (
            <div style={{ display: 'flex', 'justify-content': 'space-between', padding: '5px 0', 'border-bottom': '1px solid var(--glass-border)', 'font-size': '0.72rem' }}>
              <span style={{ color: 'var(--text-lo)' }}>{row.label}</span>
              <span style={{ color: 'var(--text-mid)', 'font-family': 'var(--font-mono)', 'font-size': '0.65rem' }}>{row.value}</span>
            </div>
          ))}
        </section>

        {/* Roadmap */}
        <section class="panel" aria-labelledby="panel-roadmap-title">
          <div id="panel-roadmap-title" class="panel__title">Build roadmap</div>
          {ROADMAP.map(item => (
            <div class="roadmap-item">
              <span class={`roadmap-item__badge roadmap-item__badge--${item.priority}`}>
                {item.priority.toUpperCase()}
              </span>
              <span style={{ flex: 1 }}>{item.label}</span>
              <span class={`roadmap-item__status roadmap-item__status--${item.done ? 'done' : 'todo'}`}>
                {item.done ? '✓' : '○'}
              </span>
            </div>
          ))}
        </section>

      </aside>
    </div>
  )
}

export default App
