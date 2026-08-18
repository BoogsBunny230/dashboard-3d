// ─── Almacén Industrial 3D ─────────────────────────────────────────
// Genera procedimentalmente estanterías con pallets usando InstancedMesh
// para lograr UNA sola draw call para todos los slots del almacén.
//
// Cada instancia contiene datos simulados: id, stock, y estado.
// El color de cada instancia refleja su estado visualmente.
//
// ⚡ OPTIMIZACIÓN ZERO-ALLOCATION (Hot Path):
//    - setHover / clearHover reutilizan `this._tempColor` y `_WHITE` estático.
//    - Estrictamente prohibido `new THREE.Color()` o `new THREE.Vector3()`
//      dentro de métodos llamados desde el handler de mousemove.
//    - getBaseColor() permanece como utilidad no-crítica (fuera del hot path).

import * as THREE from 'three';

// ─── Tipos ──────────────────────────────────────────────────────────

/** Estados posibles de un slot del almacén */
export const SlotStatus = {
  NORMAL: 'normal',
  WARNING: 'warning',
  ERROR: 'error',
  EMPTY: 'empty',
} as const;

export type SlotStatusType = (typeof SlotStatus)[keyof typeof SlotStatus];

/** Datos simulados de un slot/pallet del almacén */
export interface WarehouseSlotData {
  /** Identificador único del slot (ej. "A2-R5-L3") */
  id: string;
  /** Índice dentro del InstancedMesh (0-based) */
  instanceIndex: number;
  /** Cantidad de stock (0–100) */
  stock: number;
  /** Estado operativo */
  status: SlotStatusType;
  /** Posición lógica en el almacén */
  location: {
    aisle: number;
    row: 'L' | 'R';
    position: number;
    level: number;
  };
}

/** Actualización de stock para un slot (payload del simulador). */
export interface WarehouseStockUpdate {
  slotId: string;
  stock: number;
  status: SlotStatusType;
}

// ─── Configuración ──────────────────────────────────────────────────

export interface WarehouseConfig {
  /** Cantidad de pasillos */
  aisles: number;
  /** Posiciones de rack por fila (profundidad) */
  positionsPerRow: number;
  /** Niveles de altura */
  levels: number;
  /** Ancho de cada slot (X) */
  slotWidth: number;
  /** Alto de cada slot (Y) */
  slotHeight: number;
  /** Profundidad de cada slot (Z) */
  slotDepth: number;
  /** Espacio horizontal entre racks izquierdo y derecho de un pasillo */
  aisleWidth: number;
  /** Distancia entre centros de pasillo */
  aisleSpacing: number;
  /** Posición Z del primer slot (más cercano a la cámara) */
  firstSlotZ: number;
  /** Posición Y base (sobre el suelo) */
  baseY: number;
  /** Semilla para datos aleatorios reproducibles */
  seed: number;
}

export const DEFAULT_WAREHOUSE_CONFIG: WarehouseConfig = {
  aisles: 4,
  positionsPerRow: 8,
  levels: 4,
  slotWidth: 0.85,
  slotHeight: 0.5,
  slotDepth: 0.85,
  aisleWidth: 2.2,
  aisleSpacing: 3.8,
  firstSlotZ: -3.2,
  baseY: 0.25,
  seed: 42,
};

// ─── Colores por estado ─────────────────────────────────────────────

const STATUS_COLORS: Record<SlotStatusType, THREE.Color> = {
  [SlotStatus.NORMAL]: new THREE.Color('#10b981'),  // Emerald 500
  [SlotStatus.WARNING]: new THREE.Color('#f59e0b'), // Amber 500
  [SlotStatus.ERROR]: new THREE.Color('#ef4444'),   // Red 500
  [SlotStatus.EMPTY]: new THREE.Color('#334155'),   // Slate 700
};

const HOVER_LIGHTEN_FACTOR = 0.45; // Cuánto aclarar en hover
const HOVER_SATURATION_BOOST = 1.15;

// ─── Clase Principal ────────────────────────────────────────────────

export class WarehouseGrid {
  readonly config: WarehouseConfig;
  readonly instancedMesh: THREE.InstancedMesh;
  readonly slotData: WarehouseSlotData[];

  /** Total de instancias generadas */
  readonly totalSlots: number;

  /** Color base por índice de instancia (sin hover) */
  private readonly baseColors: Float32Array;

  /** Color actual por índice de instancia (refleja hover o base) */
  private readonly currentColors: Float32Array;

  /** Mapa de instanceIndex → slotId para búsqueda O(1) */
  private readonly indexToSlotId: Map<number, string> = new Map();

  /** Mapa de slotId → slotData para búsqueda O(1) */
  private readonly slotIdToData: Map<string, WarehouseSlotData> = new Map();

  // ═══ OBJECT POOL ═══════════════════════════════════════════════════
  // Estos objetos se reutilizan en el HOT PATH (setHover, clearHover)
  // para eliminar toda instanciación de THREE.Color durante mousemove.

  /** Color temporal reutilizable por instancia (Zero-Allocation). */
  private readonly _tempColor = new THREE.Color();

  /** Blanco puro — target del lerp de hover. Compartido entre todas las instancias. */
  private static readonly _WHITE = new THREE.Color(0xffffff);

  // ═══ OBJECT POOL: Filtro ════════════════════════════════════════════
  // Reutilizables para filterByRow — evitan alloc en cada cambio de filtro.

  private readonly _filterDummy = new THREE.Object3D();
  private readonly _filterMatrix = new THREE.Matrix4();
  private readonly _filterPos = new THREE.Vector3();

  /** Fila actualmente visible (0-7 = 8 filas reales, o 'all'). */
  private _currentFilter: number | 'all' = 'all';

  // ─── Constructor ──────────────────────────────────────────────────

  constructor(config?: Partial<WarehouseConfig>) {
    this.config = { ...DEFAULT_WAREHOUSE_CONFIG, ...config };
    const cfg = this.config;

    this.totalSlots =
      cfg.aisles * 2 * cfg.positionsPerRow * cfg.levels;

    // ── Crear geometría compartida ────────────────────────────────
    const geometry = new THREE.BoxGeometry(
      cfg.slotWidth,
      cfg.slotHeight,
      cfg.slotDepth,
    );

    // ── Crear material compartido ─────────────────────────────────
    const material = new THREE.MeshStandardMaterial({
      roughness: 0.4,
      metalness: 0.2,
      // Emisivo sutil para que el bloom afecte a los slots brillantes
      emissive: new THREE.Color(0x111111),
      emissiveIntensity: 0.25,
      color: 0x888888,
    });

    // ── Crear InstancedMesh ───────────────────────────────────────
    this.instancedMesh = new THREE.InstancedMesh(
      geometry,
      material,
      this.totalSlots,
    );

    // Inicializar instanceColor usando el blanco estático
    this.instancedMesh.setColorAt(0, WarehouseGrid._WHITE);

    // Habilitar sombras para todas las instancias
    this.instancedMesh.castShadow = true;
    this.instancedMesh.receiveShadow = true;

    // ── Buffers de color ──────────────────────────────────────────
    this.baseColors = new Float32Array(this.totalSlots * 3);
    this.currentColors = new Float32Array(this.totalSlots * 3);

    // ── Generar slots ─────────────────────────────────────────────
    this.slotData = this.generateSlots();
  }

  // ─── API Pública ────────────────────────────────────────────────

  /** Agrega el InstancedMesh a una escena */
  addToScene(scene: THREE.Scene): void {
    scene.add(this.instancedMesh);
  }

  /** Remueve el InstancedMesh de la escena */
  removeFromScene(scene: THREE.Scene): void {
    scene.remove(this.instancedMesh);
  }

  /** Obtiene los datos de un slot por su instanceIndex (para Raycaster) */
  getSlotByIndex(instanceIndex: number): WarehouseSlotData | null {
    if (instanceIndex < 0 || instanceIndex >= this.slotData.length) {
      return null;
    }
    return this.slotData[instanceIndex];
  }

  /** Obtiene datos de un slot por su ID */
  getSlotById(id: string): WarehouseSlotData | null {
    return this.slotIdToData.get(id) ?? null;
  }

  /** Obtiene el instanceIndex a partir de un slotId */
  getIndexBySlotId(slotId: string): number {
    const data = this.slotIdToData.get(slotId);
    return data?.instanceIndex ?? -1;
  }

  // ─── Hover (HOT PATH — Zero Allocation) ─────────────────────────

  /**
   * Aplica un highlight de hover al slot especificado.
   *
   * ⚡ ZERO-ALLOCATION: Reutiliza `this._tempColor` y `WarehouseGrid._WHITE`.
   *    No se crea ningún `new THREE.Color()` en este método.
   */
  setHover(instanceIndex: number): void {
    if (instanceIndex < 0 || instanceIndex >= this.totalSlots) return;

    const i3 = instanceIndex * 3;

    // Cargar color base en el objeto reciclable
    this._tempColor.setRGB(
      this.baseColors[i3],
      this.baseColors[i3 + 1],
      this.baseColors[i3 + 2],
    );

    // Aplicar efecto hover in-place (sin clones ni new)
    // 1. Lerp hacia blanco para aclarar
    this._tempColor.lerp(WarehouseGrid._WHITE, HOVER_LIGHTEN_FACTOR);
    // 2. Aumentar saturación para que destaque
    this._tempColor.multiplyScalar(HOVER_SATURATION_BOOST);

    // Enviar al InstancedMesh (setColorAt escribe en el buffer GPU)
    this.setInstanceColor(instanceIndex, this._tempColor);
  }

  /**
   * Restaura el color base de un slot (sin hover).
   *
   * ⚡ ZERO-ALLOCATION: Reutiliza `this._tempColor`.
   */
  clearHover(instanceIndex: number): void {
    if (instanceIndex < 0 || instanceIndex >= this.totalSlots) return;

    const i3 = instanceIndex * 3;

    // Cargar color base directamente desde el buffer
    this._tempColor.setRGB(
      this.baseColors[i3],
      this.baseColors[i3 + 1],
      this.baseColors[i3 + 2],
    );

    this.setInstanceColor(instanceIndex, this._tempColor);
  }

  // ─── Actualización de estado ───────────────────────────────────

  /**
   * Actualiza el stock y estado de un slot.
   * Si el estado cambió, actualiza el color visual.
   */
  updateSlot(
    slotId: string,
    updates: { stock?: number; status?: SlotStatusType },
  ): void {
    const data = this.slotIdToData.get(slotId);
    if (!data) return;

    if (updates.stock !== undefined) {
      data.stock = Math.max(0, Math.min(100, updates.stock));

      // Stock cero → estado empty automáticamente
      if (data.stock === 0) {
        data.status = SlotStatus.EMPTY;
      }
    }

    if (updates.status !== undefined) {
      data.status = updates.status;
    }

    // Actualizar color visual (referencia a objeto estático, sin new)
    const newColor = STATUS_COLORS[data.status];
    this.setBaseColor(data.instanceIndex, newColor);
    this.setInstanceColor(data.instanceIndex, newColor);
    this.flushColors();
  }

  /**
   * Actualiza múltiples slots de golpe (más eficiente).
   * Útil para sincronizar con DataSimulator.
   */
  batchUpdateSlots(
    updates: Array<{ slotId: string; stock?: number; status?: SlotStatusType }>,
  ): void {
    for (const update of updates) {
      const data = this.slotIdToData.get(update.slotId);
      if (!data) continue;

      if (update.stock !== undefined) {
        data.stock = Math.max(0, Math.min(100, update.stock));
        if (data.stock === 0) data.status = SlotStatus.EMPTY;
      }

      if (update.status !== undefined) {
        data.status = update.status;
      }

      // Referencia directa a color estático (sin new)
      const color = STATUS_COLORS[data.status];
      this.setBaseColor(data.instanceIndex, color);
      this.setInstanceColor(data.instanceIndex, color);
    }
    this.flushColors();
  }

  /**
   * Filtra las instancias visibles por fila individual (0-7) o todas.
   *
   * 📐 Mapeo de 8 filas reales:
   *    4 pasillos × 2 filas (L/R) = 8 filas.
   *    rowIndex = aisle * 2 + (row === 'L' ? 0 : 1)
   *    Ej: pasillo 0, fila L → índice 0. Pasillo 3, fila R → índice 7.
   *
   * ⚡ ZERO-COST: No crea ni destruye geometría. Solo escala las matrices
   *    de instancia a (0,0,0) para ocultar y (1,1,1) para mostrar.
   *    Una sola subida a GPU con instanceMatrix.needsUpdate = true.
   */
  filterByRow(rowId: number | 'all'): void {
    if (this._currentFilter === rowId) return;
    this._currentFilter = rowId;

    const dummy = this._filterDummy;
    const matrix = this._filterMatrix;
    const pos = this._filterPos;

    for (let i = 0; i < this.totalSlots; i++) {
      const slot = this.slotData[i];

      // Calcular índice de fila real (0-7) para este slot
      const slotRowIndex =
        slot.location.aisle * 2 + (slot.location.row === 'L' ? 0 : 1);

      const visible = rowId === 'all' || slotRowIndex === rowId;

      // Leer posición actual de la matriz de instancia
      this.instancedMesh.getMatrixAt(i, matrix);
      pos.setFromMatrixPosition(matrix);

      // Aplicar misma posición, escala según visibilidad
      dummy.position.copy(pos);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(visible ? 1 : 0, visible ? 1 : 0, visible ? 1 : 0);
      dummy.updateMatrix();

      this.instancedMesh.setMatrixAt(i, dummy.matrix);
    }

    this.instancedMesh.instanceMatrix.needsUpdate = true;
  }

  /** Retorna la fila actualmente filtrada. */
  get currentFilter(): number | 'all' {
    return this._currentFilter;
  }

  // ─── Limpieza ──────────────────────────────────────────────────

  dispose(): void {
    this.instancedMesh.geometry.dispose();
    (this.instancedMesh.material as THREE.Material).dispose();
    this.indexToSlotId.clear();
    this.slotIdToData.clear();
  }

  // ─── Generación Interna ─────────────────────────────────────────

  /**
   * Genera todos los slots del almacén.
   * Solo se ejecuta UNA vez durante la construcción — no es hot path.
   */
  private generateSlots(): WarehouseSlotData[] {
    const cfg = this.config;
    const dummy = new THREE.Object3D();
    const slots: WarehouseSlotData[] = [];
    let instanceIndex = 0;

    // Generador pseudo-aleatorio con semilla (mulberry32)
    const random = this.createSeededRandom(cfg.seed);

    for (let aisle = 0; aisle < cfg.aisles; aisle++) {
      const aisleCenterX =
        (aisle - (cfg.aisles - 1) / 2) * cfg.aisleSpacing;

      for (const row of ['L', 'R'] as const) {
        const rowOffsetX = row === 'L' ? -cfg.aisleWidth / 2 : cfg.aisleWidth / 2;
        const rackX = aisleCenterX + rowOffsetX;

        for (let pos = 0; pos < cfg.positionsPerRow; pos++) {
          const rackZ = cfg.firstSlotZ + pos * (cfg.slotDepth + 0.15);

          for (let level = 0; level < cfg.levels; level++) {
            const rackY = cfg.baseY + level * (cfg.slotHeight + 0.12);

            // Matriz de transformación para esta instancia
            dummy.position.set(rackX, rackY, rackZ);
            dummy.rotation.set(0, 0, 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            this.instancedMesh.setMatrixAt(instanceIndex, dummy.matrix);

            // Datos simulados
            const stock = this.simulateStock(random);
            const status = this.determineStatus(stock, random);

            const slotData: WarehouseSlotData = {
              id: this.formatSlotId(aisle, row, pos, level),
              instanceIndex,
              stock,
              status,
              location: { aisle, row, position: pos, level },
            };

            slots.push(slotData);

            // Color según estado (referencia a objeto pre-creado, sin new)
            const color = STATUS_COLORS[status];
            this.setBaseColor(instanceIndex, color);
            this.setInstanceColor(instanceIndex, color);

            // Índices
            this.indexToSlotId.set(instanceIndex, slotData.id);
            this.slotIdToData.set(slotData.id, slotData);

            instanceIndex++;
          }
        }
      }
    }

    // Subir buffers a la GPU
    this.instancedMesh.instanceMatrix.needsUpdate = true;
    this.flushColors();

    return slots;
  }

  // ─── Colores ────────────────────────────────────────────────────

  private setBaseColor(index: number, color: THREE.Color): void {
    const i3 = index * 3;
    this.baseColors[i3] = color.r;
    this.baseColors[i3 + 1] = color.g;
    this.baseColors[i3 + 2] = color.b;
  }

  private setInstanceColor(index: number, color: THREE.Color): void {
    const i3 = index * 3;
    this.currentColors[i3] = color.r;
    this.currentColors[i3 + 1] = color.g;
    this.currentColors[i3 + 2] = color.b;

    this.instancedMesh.setColorAt(index, color);
  }

  /** Fuerza la subida de los buffers de color a la GPU. */
  private flushColors(): void {
    if (this.instancedMesh.instanceColor) {
      this.instancedMesh.instanceColor.needsUpdate = true;
    }
  }

  // ─── Utilidades ─────────────────────────────────────────────────

  private formatSlotId(
    aisle: number,
    row: 'L' | 'R',
    position: number,
    level: number,
  ): string {
    return `A${aisle}-${row}${position}-L${level}`;
  }

  private simulateStock(random: () => number): number {
    const base = random();
    return Math.floor(20 + base * 70 + random() * 15);
  }

  private determineStatus(
    stock: number,
    random: () => number,
  ): SlotStatusType {
    if (stock === 0) return SlotStatus.EMPTY;

    const roll = random();
    if (roll < 0.03) return SlotStatus.ERROR;
    if (roll < 0.13) return SlotStatus.WARNING;
    return SlotStatus.NORMAL;
  }

  /**
   * Generador pseudo-aleatorio determinístico (mulberry32).
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
