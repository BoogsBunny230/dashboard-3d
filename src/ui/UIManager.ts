// ─── Gestor de Interfaz de Usuario ──────────────────────────────────
// Administra los paneles del dashboard superpuestos sobre el canvas 3D.
//
// Principios:
//   - La UI se posiciona con position: absolute sobre el canvas.
//   - El scroll es NATIVO del navegador (overflow-y-auto).
//   - Solo manipula el DOM; nunca toca Three.js (excepto proyección).
//   - Se comunica exclusivamente vía EventBus.
//
// 🎯 TOOLTIP FLOTANTE (v2):
//   - Reemplaza el panel lateral pesado por un pop-up minimalista.
//   - Posicionado vía proyección 3D→2D (vector.project(camera)).
//   - Se cierra con Escape, clic en vacío, o clic en otro slot.
//   - La inyección de datos se difiere con rAF para no bloquear GSAP.

import * as THREE from 'three';
import type { EventBus } from '../systems/EventBus.ts';
import type { WarehouseSlotData, WarehouseStockUpdate } from '../systems/WarehouseGrid.ts';
import { SlotStatus } from '../systems/WarehouseGrid.ts';

// ─── Configuración ──────────────────────────────────────────────────

const TOAST_DURATION_MS = 28000; // ~28s visible, se limpia antes del próximo tick (30s)
const MAX_TOASTS = 5;
const MAX_ALERT_HISTORY = 50;
const TOOLTIP_OFFSET_X = 18; // px a la derecha del slot
const TOOLTIP_OFFSET_Y = -22; // px arriba del slot

// ─── Tipos internos ─────────────────────────────────────────────────

interface AlertEntry {
  id: string;
  slotId: string;
  stock: number;
  status: string;
  timestamp: number;
}

/** Callback que resuelve un instanceIndex a una posición mundo. */
export type SlotWorldPositionResolver = (
  instanceIndex: number,
) => THREE.Vector3 | null;

// ─── Clase Principal ────────────────────────────────────────────────

export class UIManager {
  private readonly eventBus: EventBus;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly domElement: HTMLElement;
  private readonly getSlotWorldPosition: SlotWorldPositionResolver;

  // ── Referencias DOM ─────────────────────────────────────────────
  private readonly overlay: HTMLElement;
  private readonly totalSlotsEl: HTMLElement;
  private readonly alertCountEl: HTMLElement;
  private readonly lastUpdateEl: HTMLElement;
  private readonly tickCountEl: HTMLElement;
  private readonly toastContainer: HTMLElement;

  // ── Tooltip flotante ────────────────────────────────────────────
  private readonly tooltip: HTMLElement;
  private tooltipSlotId!: HTMLElement;
  private tooltipStock!: HTMLElement;
  private tooltipStockBar!: HTMLElement;
  private tooltipStatus!: HTMLElement;
  private tooltipLocation!: HTMLElement;

  // ── Barra de filtros ────────────────────────────────────────────
  private readonly filterBar: HTMLElement;
  private activeFilterButton: HTMLElement | null = null;

  /** Si el tooltip está actualmente visible. */
  private tooltipVisible = false;

  /** Última posición mundo del slot seleccionado (para re-proyección). */
  private tooltipWorldPos: THREE.Vector3 | null = null;

  // ── Estado ──────────────────────────────────────────────────────

  private alertEntries: AlertEntry[] = [];
  private readonly activeAlertIds = new Set<string>();
  private listenerIds: string[] = [];
  private lastTickTime = 0;
  private alertListDirty = true;
  private activeToastCount = 0;

  // ── Templates ───────────────────────────────────────────────────
  private readonly _alertRowTemplate: HTMLElement;

  // ─── Constructor ────────────────────────────────────────────────

  constructor(
    eventBus: EventBus,
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    getSlotWorldPosition: SlotWorldPositionResolver,
  ) {
    this.eventBus = eventBus;
    this.camera = camera;
    this.domElement = domElement;
    this.getSlotWorldPosition = getSlotWorldPosition;

    // ── Referencias DOM ───────────────────────────────────────────
    this.overlay = this.requireElement('dashboard-overlay');
    this.totalSlotsEl = this.requireElement('total-slots');
    this.alertCountEl = this.requireElement('alert-count');
    this.lastUpdateEl = this.requireElement('last-update');
    this.tickCountEl = this.requireElement('tick-count');
    this.toastContainer = this.requireElement('toast-container');

    // ── Template de fila de alerta ────────────────────────────────
    this._alertRowTemplate = document.createElement('div');
    this._alertRowTemplate.className =
      'flex items-center justify-between py-1.5 text-xs';

    // ── Construir tooltip flotante ────────────────────────────────
    this.tooltip = this.buildTooltip();
    this.overlay.appendChild(this.tooltip);

    // ── Construir barra de filtros ─────────────────────────────────
    this.filterBar = this.buildFilterBar();
    this.overlay.appendChild(this.filterBar);

    // ── Suscribirse a eventos ─────────────────────────────────────
    this.subscribe();
  }

  // ─── Inicialización ─────────────────────────────────────────────

  setTotalSlots(total: number): void {
    this.totalSlotsEl.textContent = String(total);
  }

  // ─── Limpieza ───────────────────────────────────────────────────

  dispose(): void {
    for (const id of this.listenerIds) {
      this.eventBus.off(id);
    }
    this.listenerIds.length = 0;

    while (this.toastContainer.firstChild) {
      this.toastContainer.firstChild.remove();
    }
    this.activeToastCount = 0;
    this.activeAlertIds.clear();

    // Remover tooltip del DOM
    if (this.tooltip.parentNode) {
      this.tooltip.parentNode.removeChild(this.tooltip);
    }
    // Remover barra de filtros
    if (this.filterBar.parentNode) {
      this.filterBar.parentNode.removeChild(this.filterBar);
    }
  }

  // ─── Suscripciones al EventBus ──────────────────────────────────

  private subscribe(): void {
    // Click en slot → GSAP inmediato, UI diferida 50ms (fuera del hot path)
    this.listenerIds.push(
      this.eventBus.on('warehouse:slot-clicked', ({ slot }) => {
        // 🚀 PATRÓN DESACOPLADO:
        //    CameraController (listener anterior) ejecuta focusOnPosition sync → GSAP arranca.
        //    La UI se difiere con setTimeout(50ms) para sacarla del hilo de renderizado.
        //    Esto da ~3 frames (a 60fps) de animación de cámara sin DOM competition.
        setTimeout(() => {
          this.showTooltip(slot);
        }, 50);
      }),
    );

    // Datos actualizados → notificaciones + contadores
    this.listenerIds.push(
      this.eventBus.on('warehouse:stock-updated', (updates) => {
        this.handleStockUpdates(updates);
      }),
    );

    // Deseleccionar → ocultar tooltip
    this.listenerIds.push(
      this.eventBus.on('ui:deselect-entity', () => {
        this.hideTooltip();
      }),
    );

    // Re-posicionar tooltip cada frame si está visible (el usuario puede orbitar)
    this.listenerIds.push(
      this.eventBus.on('sim:tick', () => {
        if (this.tooltipVisible && this.tooltipWorldPos) {
          this.positionTooltip(this.tooltipWorldPos);
        }
      }),
    );
  }

  // ─── Tooltip Flotante ───────────────────────────────────────────

  /** Construye el elemento DOM del tooltip una sola vez. */
  private buildTooltip(): HTMLElement {
    const container = document.createElement('div');
    // ⚡ GPU-ACCELERATED: posicionado vía transform: translate3d().
    //    NUNCA usar left/top — fuerzan layout sincrónico (Layout Thrashing).
    //    top-0 left-0 como base, translate3d aplica el offset real.
    container.className = [
      'pointer-events-auto absolute z-30 top-0 left-0',
      'bg-slate-950/95 backdrop-blur-lg',
      'border border-slate-700/60 rounded-lg',
      'shadow-2xl shadow-black/60',
      'px-3.5 py-3 text-xs',
      'min-w-[180px] max-w-[220px]',
      'transition-opacity duration-200',
    ].join(' ');
    container.style.display = 'none';
    container.style.opacity = '0';
    // Forzar promoción a capa de GPU (compositor-only, evita paint)
    container.style.willChange = 'transform, opacity';

    // ── Flecha / indicador (triángulo CSS) ────────────────────────
    const arrow = document.createElement('div');
    arrow.className = [
      'absolute -bottom-1.5 left-1/2 -translate-x-1/2',
      'w-3 h-3 rotate-45',
      'bg-slate-950/95 border-r border-b border-slate-700/60',
    ].join(' ');
    container.appendChild(arrow);

    // ── Slot ID ────────────────────────────────────────────────────
    const idLabel = document.createElement('span');
    idLabel.className = 'text-[10px] uppercase tracking-widest text-slate-500';
    idLabel.textContent = 'Slot ID';
    container.appendChild(idLabel);

    this.tooltipSlotId = document.createElement('p');
    this.tooltipSlotId.className = 'text-sm font-mono font-semibold text-white mb-2';
    container.appendChild(this.tooltipSlotId);

    // ── Stock + barra ──────────────────────────────────────────────
    const stockRow = document.createElement('div');
    stockRow.className = 'flex items-center gap-2 mb-1';

    this.tooltipStock = document.createElement('span');
    this.tooltipStock.className = 'text-lg font-mono font-bold';

    stockRow.appendChild(this.tooltipStock);
    container.appendChild(stockRow);

    const barTrack = document.createElement('div');
    barTrack.className = 'w-full bg-slate-700 rounded-full h-1.5 overflow-hidden mb-2';

    this.tooltipStockBar = document.createElement('div');
    this.tooltipStockBar.className = 'h-full rounded-full transition-all duration-500';
    barTrack.appendChild(this.tooltipStockBar);
    container.appendChild(barTrack);

    // ── Estado ─────────────────────────────────────────────────────
    this.tooltipStatus = document.createElement('p');
    this.tooltipStatus.className = 'text-[11px] font-semibold mb-1.5';
    container.appendChild(this.tooltipStatus);

    // ── Ubicación ──────────────────────────────────────────────────
    this.tooltipLocation = document.createElement('p');
    this.tooltipLocation.className = 'text-[10px] text-slate-500 font-mono';
    container.appendChild(this.tooltipLocation);

    return container;
  }

  /** Construye la barra de filtros (8 filas + Vista Global, inferior centrada). */
  private buildFilterBar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = [
      'pointer-events-auto absolute bottom-5 left-1/2 z-20',
      'flex items-center gap-1.5',
      'bg-slate-950/85 backdrop-blur-md',
      'border border-slate-700/50 rounded-xl',
      'px-3 py-2 shadow-2xl shadow-black/60',
    ].join(' ');
    bar.style.transform = 'translateX(-50%)';

    // ── Botones de fila 1-8 ────────────────────────────────────────
    for (let rowIndex = 0; rowIndex < 8; rowIndex++) {
      const button = document.createElement('button');
      button.className = [
        'px-3 py-1.5 rounded-lg text-xs font-medium font-mono',
        'transition-all duration-200',
        'border border-slate-600/40',
        'text-slate-400 hover:text-white',
        'hover:bg-slate-800 hover:border-slate-500',
      ].join(' ');
      button.textContent = `F${rowIndex + 1}`;
      button.title = `Fila ${rowIndex + 1}`;

      button.addEventListener('click', () => {
        this._setActiveFilterButton(button);
        this.eventBus.emit('ui:filter-row', { row: rowIndex });
      });

      bar.appendChild(button);
    }

    // ── Separador ──────────────────────────────────────────────────
    const sep = document.createElement('div');
    sep.className = 'w-px h-5 bg-slate-600/40 mx-1';
    bar.appendChild(sep);

    // ── Botón "Todo" ───────────────────────────────────────────────
    const allBtn = document.createElement('button');
    allBtn.className = [
      'px-3 py-1.5 rounded-lg text-xs font-semibold',
      'transition-all duration-200',
      'border border-slate-500/60',
      'bg-slate-700 text-white',
    ].join(' ');
    allBtn.textContent = 'Todo';
    allBtn.title = 'Mostrar todas las filas';
    this.activeFilterButton = allBtn;

    allBtn.addEventListener('click', () => {
      this._setActiveFilterButton(allBtn);
      this.eventBus.emit('ui:filter-row', { row: 'all' });
    });

    bar.appendChild(allBtn);

    // ── Botón "Vista Global" (reset cámara) ────────────────────────
    const resetBtn = document.createElement('button');
    resetBtn.className = [
      'px-3 py-1.5 rounded-lg text-xs font-semibold',
      'transition-all duration-200',
      'border border-emerald-500/50',
      'text-emerald-400 hover:text-emerald-300',
      'hover:bg-emerald-500/10 hover:border-emerald-400',
    ].join(' ');
    resetBtn.textContent = '🌐 Vista Global';
    resetBtn.title = 'Restablecer cámara a la posición inicial';

    resetBtn.addEventListener('click', () => {
      this.eventBus.emit('ui:reset-camera');
    });

    bar.appendChild(resetBtn);

    return bar;
  }

  /** Actualiza el estilo del botón de filtro activo. */
  private _setActiveFilterButton(active: HTMLElement): void {
    if (this.activeFilterButton) {
      this.activeFilterButton.classList.remove(
        'bg-slate-700', 'text-white', 'border-slate-500',
      );
      this.activeFilterButton.classList.add(
        'border-slate-600/40', 'text-slate-400',
      );
    }
    active.classList.remove('border-slate-600/40', 'text-slate-400');
    active.classList.add('bg-slate-700', 'text-white', 'border-slate-500');
    this.activeFilterButton = active;
  }

  /**
   * Muestra el tooltip junto al slot clickeado.
   * Calcula la posición 3D→2D y popula los datos.
   */
  private showTooltip(slot: WarehouseSlotData): void {
    const worldPos = this.getSlotWorldPosition(slot.instanceIndex);
    if (!worldPos) return;

    // ── Datos del slot ─────────────────────────────────────────────
    this.tooltipSlotId.textContent = slot.id;

    const stockColorClass =
      slot.stock > 60
        ? 'text-emerald-400'
        : slot.stock > 25
          ? 'text-amber-400'
          : 'text-red-400';
    this.tooltipStock.className = `text-lg font-mono font-bold ${stockColorClass}`;
    this.tooltipStock.textContent = `${slot.stock}%`;

    const barColor =
      slot.stock > 60 ? '#10b981' : slot.stock > 25 ? '#f59e0b' : '#ef4444';
    this.tooltipStockBar.style.width = `${slot.stock}%`;
    this.tooltipStockBar.style.background = barColor;

    const statusLabels: Record<string, string> = {
      normal: '✅ Normal',
      warning: '⚠️ Precaución',
      error: '🔴 Crítico',
      empty: '⚫ Vacío',
    };
    const statusColors: Record<string, string> = {
      normal: 'text-emerald-400',
      warning: 'text-amber-400',
      error: 'text-red-400',
      empty: 'text-slate-500',
    };
    this.tooltipStatus.className = `text-[11px] font-semibold ${statusColors[slot.status] ?? 'text-slate-400'}`;
    this.tooltipStatus.textContent = statusLabels[slot.status] ?? slot.status;

    this.tooltipLocation.textContent =
      `A${slot.location.aisle}-${slot.location.row}${slot.location.position} · Nivel ${slot.location.level}`;

    // ── Posicionar y mostrar ──────────────────────────────────────
    this.tooltipWorldPos = worldPos.clone();
    this.positionTooltip(worldPos);
    this.tooltip.style.display = '';
    this.tooltipVisible = true;

    // Animación de entrada
    requestAnimationFrame(() => {
      this.tooltip.style.opacity = '1';
    });
  }

  /** Oculta el tooltip con animación de salida. */
  private hideTooltip(): void {
    if (!this.tooltipVisible) return;

    this.tooltip.style.opacity = '0';
    this.tooltipVisible = false;
    this.tooltipWorldPos = null;

    // Ocultar completamente después de la transición CSS
    setTimeout(() => {
      if (!this.tooltipVisible) {
        this.tooltip.style.display = 'none';
      }
    }, 200);
  }

  /**
   * Proyecta una posición mundo a coordenadas de pantalla y posiciona el tooltip.
   *
   * 📐 Proyección: worldPos → NDC (-1..1) → CSS px.
   * ⚡ Se llama en cada frame (sim:tick) mientras el tooltip está visible
   *    para seguir al slot durante la órbita de cámara.
   */
  /**
   * Proyecta una posición mundo a coordenadas de pantalla y posiciona el tooltip.
   *
   * 📐 Proyección: worldPos → NDC (-1..1) → CSS px.
   * ⚡ GPU-ACCELERATED: usa transform: translate3d() en vez de left/top.
   *    left/top disparan Layout (Forced Synchronous Layout) → jank.
   *    translate3d() opera solo en la capa de compositor → 60fpm estables.
   * ⚡ Se llama en cada frame (sim:tick) mientras el tooltip está visible
   *    para seguir al slot durante la órbita de cámara.
   */
  private positionTooltip(worldPos: THREE.Vector3): void {
    // Clonar para no mutar la posición almacenada
    const screenPos = worldPos.clone().project(this.camera);

    // Convertir NDC a CSS px relativos al viewport
    const containerWidth = this.domElement.clientWidth;
    const containerHeight = this.domElement.clientHeight;

    const screenX = (screenPos.x * 0.5 + 0.5) * containerWidth;
    const screenY = (-screenPos.y * 0.5 + 0.5) * containerHeight;

    // Aplicar offset para que el tooltip quede al lado del slot, no encima
    const x = screenX + TOOLTIP_OFFSET_X;
    const y = screenY + TOOLTIP_OFFSET_Y;

    // Mantener dentro del viewport (clamp simple)
    const tooltipWidth = 200; // estimado
    const tooltipHeight = 140; // estimado
    const clampedX = Math.max(8, Math.min(x, containerWidth - tooltipWidth - 8));
    const clampedY = Math.max(8, Math.min(y, containerHeight - tooltipHeight - 8));

    // ⚡ GPU layer: translate3d(x, y, 0) → solo compositor, cero layout.
    //    El tooltip tiene top:0; left:0 como base en su className.
    this.tooltip.style.transform = `translate3d(${clampedX}px, ${clampedY}px, 0)`;
  }

  // ─── Actualizaciones de Stock ───────────────────────────────────

  private handleStockUpdates(updates: WarehouseStockUpdate[]): void {
    const now = Date.now();
    let alertsChanged = false;

    // ── Actualizar Set de alertas activas ──────────────────────────
    for (let i = 0; i < updates.length; i++) {
      const u = updates[i];
      const isAlert = u.status === SlotStatus.WARNING || u.status === SlotStatus.ERROR;

      if (isAlert) {
        if (!this.activeAlertIds.has(u.slotId)) {
          this.activeAlertIds.add(u.slotId);
          alertsChanged = true;

          this.alertEntries.unshift({
            id: `${u.slotId}-${now}-${i}`,
            slotId: u.slotId,
            stock: u.stock,
            status: u.status,
            timestamp: now,
          });
        }
      } else {
        if (this.activeAlertIds.delete(u.slotId)) {
          alertsChanged = true;
        }
      }
    }

    if (this.alertEntries.length > MAX_ALERT_HISTORY) {
      this.alertEntries.length = MAX_ALERT_HISTORY;
      alertsChanged = true;
    }

    this.alertListDirty = this.alertListDirty || alertsChanged;

    // ── Contadores ────────────────────────────────────────────────
    this.alertCountEl.textContent = String(this.activeAlertIds.size);

    const seconds = this.lastTickTime > 0
      ? Math.round((now - this.lastTickTime) / 1000)
      : 0;
    this.lastTickTime = now;
    this.lastUpdateEl.textContent = seconds > 0 ? `Hace ${seconds}s` : 'Ahora';
    this.tickCountEl.textContent = String(updates.length);

    // ── Toasts ────────────────────────────────────────────────────
    const alertsForToast: WarehouseStockUpdate[] = [];
    for (let i = 0; i < updates.length && alertsForToast.length < 2; i++) {
      const u = updates[i];
      if (u.status === SlotStatus.WARNING || u.status === SlotStatus.ERROR) {
        alertsForToast.push(u);
      }
    }

    for (let i = 0; i < alertsForToast.length; i++) {
      this.showToast(alertsForToast[i]);
    }
  }

  // ─── Toasts ─────────────────────────────────────────────────────

  private showToast(update: WarehouseStockUpdate): void {
    const statusConfig: Record<string, { icon: string; style: string; label: string }> = {
      warning: {
        icon: '⚠️',
        style: 'border-amber-500/30 bg-amber-500/5',
        label: 'Stock bajo',
      },
      error: {
        icon: '🔴',
        style: 'border-red-500/30 bg-red-500/5',
        label: 'Stock crítico',
      },
    };

    const cfg = statusConfig[update.status] ?? {
      icon: '📦',
      style: 'border-slate-600/30 bg-slate-800/50',
      label: 'Actualización',
    };

    const toast = document.createElement('div');
    toast.className = [
      'pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-lg',
      'border backdrop-blur-sm',
      cfg.style,
      'text-sm text-slate-200 shadow-lg',
      'animate-slide-in',
    ].join(' ');

    const iconSpan = document.createElement('span');
    iconSpan.className = 'text-lg';
    iconSpan.textContent = cfg.icon;

    const textDiv = document.createElement('div');
    const titleP = document.createElement('p');
    titleP.className = 'font-medium';
    titleP.textContent = update.slotId;

    const detailP = document.createElement('p');
    detailP.className = 'text-xs text-slate-400';
    detailP.textContent = `${cfg.label}: ${update.stock}%`;

    textDiv.appendChild(titleP);
    textDiv.appendChild(detailP);
    toast.appendChild(iconSpan);
    toast.appendChild(textDiv);

    this.toastContainer.appendChild(toast);
    this.activeToastCount++;

    while (this.activeToastCount > MAX_TOASTS) {
      const oldest = this.toastContainer.firstChild;
      if (oldest) {
        this._removeToastElement(oldest as HTMLElement);
      }
    }

    const cleanupTimer = setTimeout(() => {
      this._removeToastElement(toast);
    }, TOAST_DURATION_MS);

    toast.dataset.cleanupTimer = String(cleanupTimer);
  }

  private _removeToastElement(el: HTMLElement): void {
    const timerId = el.dataset.cleanupTimer;
    if (timerId) {
      clearTimeout(Number(timerId));
      delete el.dataset.cleanupTimer;
    }

    if (el.parentNode === this.toastContainer) {
      el.classList.add('opacity-0', 'transition-opacity', 'duration-300');
      setTimeout(() => {
        if (el.parentNode) {
          el.remove();
          this.activeToastCount--;
        }
      }, 300);
    }
  }

  // ─── Utilidades DOM ─────────────────────────────────────────────

  private requireElement(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) {
      throw new Error(`[UIManager] Elemento #${id} no encontrado en el DOM.`);
    }
    return el;
  }
}
