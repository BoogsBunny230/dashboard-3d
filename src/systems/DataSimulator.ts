// ─── Simulador de Telemetría Industrial ─────────────────────────────
// Emula un stream de datos tipo WebSocket/PLC generando fluctuaciones
// periódicas de stock para los slots del almacén.
//
// Cada tick:
//   1. Selecciona un subconjunto aleatorio de slots (~10-15%).
//   2. Aplica una variación de stock (-5 a +5 unidades).
//   3. Determina el nuevo estado (normal/warning/error/empty).
//   4. Emite warehouse:stock-updated vía EventBus.
//
// Configurable: intervalo, batch size, probabilidad de anomalías.
//
// ⚡ OPTIMIZACIÓN ZERO-ALLOCATION (pickRandomIndices):
//    - `_pool` y `_result` son Uint16Array pre-asignados en el constructor.
//    - Se reinicializan con un bucle for tradicional en cada tick.
//    - Cero allocaciones de arrays en el hot path de simulación.

import type { EventBus } from './EventBus.ts';
import type { WarehouseStockUpdate, SlotStatusType } from './WarehouseGrid.ts';
import { SlotStatus } from './WarehouseGrid.ts';

// ─── Configuración ──────────────────────────────────────────────────

export interface DataSimulatorConfig {
  /** Intervalo entre ticks en milisegundos. */
  intervalMs: number;
  /** Cantidad de slots a actualizar por tick. */
  batchSize: number;
  /** Probabilidad de que un slot entre en estado warning (0-1). */
  warningProbability: number;
  /** Probabilidad de que un slot entre en estado error (0-1). */
  errorProbability: number;
  /** Magnitud máxima de cambio de stock por tick. */
  maxStockDelta: number;
  /** Si es true, arranca automáticamente al construir. */
  autoStart: boolean;
}

export const DEFAULT_SIMULATOR_CONFIG: DataSimulatorConfig = {
  intervalMs: 30000,
  batchSize: 28, // ~11% de 256 slots
  warningProbability: 0.08,
  errorProbability: 0.03,
  maxStockDelta: 5,
  autoStart: true,
};

// ─── Clase Principal ────────────────────────────────────────────────

export class DataSimulator {
  private readonly eventBus: EventBus;
  private readonly config: DataSimulatorConfig;
  private readonly slotIds: string[];

  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private tickCount = 0;

  /** Generador pseudo-aleatorio con semilla para reproducibilidad. */
  private readonly random: () => number;

  // ═══ OBJECT POOL ═══════════════════════════════════════════════════
  // Buffers pre-asignados para el algoritmo de selección aleatoria.
  // Se reinician y reutilizan en cada tick SIN crear nuevos arrays.

  /**
   * Pool de índices para Fisher-Yates parcial.
   * Tamaño = total de slots (ej. 256). Pre-asignado una vez.
   */
  private readonly _pool: Uint16Array;

  /**
   * Buffer de resultado con los índices seleccionados en cada tick.
   * Tamaño = batchSize máximo. Pre-asignado una vez.
   */
  private readonly _result: Uint16Array;

  // ─── Constructor ──────────────────────────────────────────────────

  constructor(
    eventBus: EventBus,
    slotIds: string[],
    config?: Partial<DataSimulatorConfig>,
  ) {
    this.eventBus = eventBus;
    this.slotIds = [...slotIds]; // Copia defensiva
    this.config = { ...DEFAULT_SIMULATOR_CONFIG, ...config };

    // Semilla basada en timestamp para variabilidad entre sesiones,
    // pero determinística dentro de cada sesión.
    this.random = this.createSeededRandom(Date.now() & 0xffffffff);

    // ── Pre-asignar buffers de selección ────────────────────────────
    // Uint16Array: 2 bytes por elemento. Pool de 256 = 512 bytes.
    // Result de batchSize = 60 bytes. Asignación única, reutilizada.
    this._pool = new Uint16Array(this.slotIds.length);
    this._result = new Uint16Array(this.config.batchSize);

    if (this.config.autoStart) {
      this.start();
    }
  }

  // ─── Control ────────────────────────────────────────────────────

  start(): void {
    if (this.running) return;

    this.running = true;
    this.intervalId = setInterval(() => {
      this.tick();
    }, this.config.intervalMs);

    // Primer tick inmediato para no esperar el intervalo inicial
    this.tick();
  }

  pause(): void {
    if (!this.running || this.intervalId === null) return;

    clearInterval(this.intervalId);
    this.intervalId = null;
    this.running = false;
  }

  resume(): void {
    if (this.running) return;
    this.start();
  }

  get isRunning(): boolean {
    return this.running;
  }

  get ticks(): number {
    return this.tickCount;
  }

  // ─── Limpieza ───────────────────────────────────────────────────

  dispose(): void {
    this.pause();
  }

  // ─── Lógica de Simulación ───────────────────────────────────────

  private tick(): void {
    this.tickCount++;
    const cfg = this.config;
    const totalSlots = this.slotIds.length;
    const batchSize = Math.min(cfg.batchSize, totalSlots);

    // ── Seleccionar índices sin allocación ──────────────────────────
    this.pickRandomIndices(totalSlots, batchSize);

    // ── Construir updates ───────────────────────────────────────────
    // Nota: el array `updates` y los objetos `WarehouseStockUpdate`
    // se asignan una vez por tick (~cada 2.5s). Esto es aceptable:
    // no es el hot path de mousemove a 60 fps.
    const updates: WarehouseStockUpdate[] = [];

    for (let i = 0; i < batchSize; i++) {
      const idx = this._result[i];
      const slotId = this.slotIds[idx];
      const update = this.simulateStockChange(slotId);
      updates.push(update);
    }

    if (updates.length > 0) {
      this.eventBus.emit('warehouse:stock-updated', updates);
    }
  }

  private simulateStockChange(slotId: string): WarehouseStockUpdate {
    const r = this.random;
    const cfg = this.config;
    const roll = r();

    let stock: number;
    let status: SlotStatusType;

    if (roll < cfg.errorProbability) {
      // Error: stock muy bajo
      stock = Math.floor(r() * 20);
      status = SlotStatus.ERROR;
    } else if (roll < cfg.errorProbability + cfg.warningProbability) {
      // Warning: stock bajo
      stock = Math.floor(15 + r() * 25);
      status = SlotStatus.WARNING;
    } else {
      // Normal: stock saludable con fluctuación
      const baseStock = 50 + Math.floor(r() * 45); // 50–95
      const delta = Math.floor((r() - 0.5) * 2 * cfg.maxStockDelta);
      stock = Math.max(0, Math.min(100, baseStock + delta));
      status = stock === 0 ? SlotStatus.EMPTY : SlotStatus.NORMAL;
    }

    return { slotId, stock, status };
  }

  // ─── Utilidades ─────────────────────────────────────────────────

  /**
   * Selecciona `count` índices aleatorios sin reposición del rango [0, total).
   * Algoritmo de Fisher-Yates parcial.
   *
   * ⚡ ZERO-ALLOCATION:
   *    - `this._pool` se reinicia con un bucle for (sin Array.from).
   *    - `this._result` se sobrescribe en cada iteración (sin push).
   *    - No se crea ningún array nuevo ni se usa .map()/.filter().
   */
  private pickRandomIndices(total: number, count: number): void {
    const n = Math.min(count, total);

    // ── Reiniciar pool: escribir 0, 1, 2, ..., total-1 ─────────────
    // Bucle for tradicional. Cero allocaciones.
    for (let i = 0; i < total; i++) {
      this._pool[i] = i;
    }

    // ── Fisher-Yates parcial in-place ──────────────────────────────
    // Solo necesitamos los primeros `n` elementos barajados.
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(this.random() * (total - i));

      // Swap pool[i] <-> pool[j]
      const tmp = this._pool[i];
      this._pool[i] = this._pool[j];
      this._pool[j] = tmp;

      // Copiar el elemento seleccionado al buffer de resultado
      this._result[i] = this._pool[i];
    }
  }

  /**
   * Generador pseudo-aleatorio mulberry32.
   * Determinístico dada una semilla; suficiente para simulación.
   */
  private createSeededRandom(seed: number): () => number {
    let state = seed | 0;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
}
