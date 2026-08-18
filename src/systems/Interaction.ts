// ─── Sistema de Interactividad ──────────────────────────────────────
// Maneja la detección de hover y click sobre InstancedMesh usando Raycaster.
//
// Soporta múltiples InstancedMesh simultáneamente (ej. almacén + equipos).
// Cada mesh registrado tiene asociado un resolver que traduce instanceIndex
// a datos de la entidad, y callbacks para aplicar/quitar hover visual.
//
// ⚡ DEFENSE-IN-DEPTH (Throttling):
//    - El procesamiento de hover está limitado a UNA ejecución por animation frame
//      mediante un throttle basado en requestAnimationFrame.
//    - La posición del mouse siempre se actualiza en cada mousemove para mantener
//      precisión en el click, pero el raycast + setHover solo corre 1×/frame.
//    - Si el instanceId no cambió respecto al frame anterior, se omite la
//      actualización visual (evita llamadas redundantes a setColorAt).

import * as THREE from 'three';
import type { EventBus } from './EventBus.ts';
import type { EventName } from '../types/events.ts';

// ─── Tipos ──────────────────────────────────────────────────────────

/** Función que obtiene datos a partir del instanceIndex */
export type DataResolver<T = Record<string, unknown>> = (
  instanceIndex: number,
) => T | null;

/** Función que aplica el efecto visual de hover */
export type HoverApplier = (instanceIndex: number) => void;

/** Función que remueve el efecto visual de hover */
export type HoverClearer = (instanceIndex: number) => void;

/** Descriptor de un mesh interactivo registrado */
interface InteractiveTarget {
  mesh: THREE.InstancedMesh;
  resolver: DataResolver;
  onHover: HoverApplier;
  onUnhover: HoverClearer;
  onClickEvent: EventName;
  onHoverEvent: EventName;
  onUnhoverEvent: EventName;
}

// ─── Clase Principal ────────────────────────────────────────────────

export class Interaction {
  private readonly eventBus: EventBus;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly domElement: HTMLElement;
  private readonly raycaster: THREE.Raycaster;

  /** Meshes registrados para interactividad */
  private readonly targets: InteractiveTarget[] = [];

  /** Instancia actualmente en hover (index y mesh) */
  private hovered: {
    target: InteractiveTarget;
    instanceIndex: number;
  } | null = null;

  /** Coordenadas normalizadas del mouse (se actualizan en cada mousemove) */
  private readonly mouse = new THREE.Vector2();

  /** Bound handlers para poder removerlos en dispose() */
  private readonly boundMouseMove: (event: MouseEvent) => void;
  private readonly boundClick: (event: MouseEvent) => void;
  private readonly boundTouchStart: (event: TouchEvent) => void;

  /** Si es true, ignora eventos (útil durante transiciones de cámara) */
  private enabled = true;

  // ═══ THROTTLING ════════════════════════════════════════════════════
  // El procesamiento de hover (raycast + setColorAt) está limitado
  // a 1 ejecución por animation frame. Esto evita saturar la GPU
  // con llamadas redundantes a setColorAt durante movimientos rápidos.

  /** Si es true, ya hay un hover pending para el frame actual. */
  private _hoverThrottled = false;

  /** Callback vinculado para resetear el throttle (evita allocaciones). */
  private readonly _resetHoverThrottle: () => void;

  // ─── Constructor ────────────────────────────────────────────────

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    eventBus: EventBus,
  ) {
    this.camera = camera;
    this.domElement = domElement;
    this.eventBus = eventBus;
    this.raycaster = new THREE.Raycaster();

    // Ajustar precisión del raycaster para InstancedMesh
    this.raycaster.params.Points.threshold = 0.1;
    this.raycaster.params.Line = { threshold: 0.1 };

    // Vincular handlers
    this.boundMouseMove = this.handleMouseMove.bind(this);
    this.boundClick = this.handleClick.bind(this);
    this.boundTouchStart = this.handleTouchStart.bind(this);

    // Vincular reset del throttle
    this._resetHoverThrottle = this._onHoverThrottleReset.bind(this);

    // Registrar eventos DOM
    domElement.addEventListener('mousemove', this.boundMouseMove, {
      passive: true,
    });
    domElement.addEventListener('click', this.boundClick);
    domElement.addEventListener('touchstart', this.boundTouchStart, {
      passive: false,
    });
  }

  // ─── Registro de Targets ────────────────────────────────────────

  /**
   * Registra un InstancedMesh como interactivo.
   */
  register<T>(options: {
    mesh: THREE.InstancedMesh;
    resolver: DataResolver<T>;
    onHover: HoverApplier;
    onUnhover: HoverClearer;
    onClickEvent: EventName;
    onHoverEvent: EventName;
    onUnhoverEvent: EventName;
  }): void {
    this.targets.push({
      mesh: options.mesh,
      resolver: options.resolver as DataResolver,
      onHover: options.onHover,
      onUnhover: options.onUnhover,
      onClickEvent: options.onClickEvent,
      onHoverEvent: options.onHoverEvent,
      onUnhoverEvent: options.onUnhoverEvent,
    });
  }

  /** Elimina un mesh del registro de interactividad */
  unregister(mesh: THREE.InstancedMesh): void {
    const index = this.targets.findIndex((t) => t.mesh === mesh);
    if (index !== -1) {
      this.targets.splice(index, 1);
    }

    // Si el mesh removido estaba en hover, limpiar
    if (this.hovered?.target.mesh === mesh) {
      this.hovered.target.onUnhover(this.hovered.instanceIndex);
      this.hovered = null;
    }
  }

  // ─── Control ────────────────────────────────────────────────────

  /** Habilita/deshabilita la interactividad temporalmente */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;

    // Si se deshabilita, limpiar hover pendiente
    if (!enabled && this.hovered) {
      this.hovered.target.onUnhover(this.hovered.instanceIndex);
      this.hovered = null;
    }
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  // ─── Limpieza ───────────────────────────────────────────────────

  dispose(): void {
    this.domElement.removeEventListener('mousemove', this.boundMouseMove);
    this.domElement.removeEventListener('click', this.boundClick);
    this.domElement.removeEventListener('touchstart', this.boundTouchStart);

    // Limpiar hover pendiente
    if (this.hovered) {
      this.hovered.target.onUnhover(this.hovered.instanceIndex);
      this.hovered = null;
    }

    this.targets.length = 0;
  }

  // ─── Handlers de Eventos ────────────────────────────────────────

  /**
   * Actualiza la posición del mouse en cada evento (sin throttle —
   * necesitamos precisión para el click).
   *
   * El procesamiento pesado (raycast + setHover) se difiere al
   * siguiente animation frame y se ejecuta como máximo 1 vez/frame.
   */
  private handleMouseMove(event: MouseEvent): void {
    if (!this.enabled) return;

    // Siempre actualizar coordenadas del mouse (ligero, sin allocs)
    this.updateMouse(event);

    // Throttle: solo un proceso de hover por animation frame
    if (this._hoverThrottled) return;
    this._hoverThrottled = true;
    requestAnimationFrame(this._resetHoverThrottle);

    // Procesar hover UNA vez por frame
    this.processHover();
  }

  /**
   * Resetea el flag de throttle. Se llama vía rAF.
   */
  private _onHoverThrottleReset(): void {
    this._hoverThrottled = false;
  }

  /**
   * Ejecuta el raycast contra los targets registrados y actualiza
   * el estado de hover si el instanceId cambió respecto al frame anterior.
   *
   * ⚡ DEFENSE-IN-DEPTH:
   *    Solo llama a setHover/clearHover si el instanceIndex es distinto
   *    al que ya está en hover, evitando llamadas redundantes a setColorAt
   *    y reduciendo el tráfico de buffers a la GPU.
   */
  private processHover(): void {
    const intersection = this.raycast();

    if (intersection) {
      const { target, instanceIndex } = intersection;

      // ¿Es el MISMO slot que ya estaba en hover?
      if (
        this.hovered !== null &&
        this.hovered.target === target &&
        this.hovered.instanceIndex === instanceIndex
      ) {
        return; // Sin cambios — ahorramos setColorAt
      }

      // Salir del slot anterior
      if (this.hovered !== null) {
        this.hovered.target.onUnhover(this.hovered.instanceIndex);
        this.eventBus.emit(this.hovered.target.onUnhoverEvent, {
          slotId: this.getSlotIdFromTarget(this.hovered),
        });
      }

      // Entrar al nuevo slot
      target.onHover(instanceIndex);
      this.hovered = { target, instanceIndex };

      const data = target.resolver(instanceIndex) as
        | { id?: string }
        | null;
      this.eventBus.emit(target.onHoverEvent, {
        slotId: data?.id ?? `unknown-${instanceIndex}`,
      });
    } else {
      // Mouse fuera de todos los targets
      if (this.hovered !== null) {
        this.hovered.target.onUnhover(this.hovered.instanceIndex);
        this.eventBus.emit(this.hovered.target.onUnhoverEvent, {
          slotId: this.getSlotIdFromTarget(this.hovered),
        });
        this.hovered = null;
      }
    }
  }

  private handleClick(event: MouseEvent): void {
    if (!this.enabled) return;

    this.updateMouse(event);
    const intersection = this.raycast();

    if (intersection) {
      const { target, instanceIndex } = intersection;
      const data = target.resolver(instanceIndex);
      if (data) {
        this.eventBus.emit(
          target.onClickEvent,
          { slot: data } as never,
        );
      }
    } else {
      // Click en espacio vacío → cerrar tooltip / deseleccionar
      this.eventBus.emit('ui:deselect-entity' as EventName);
    }
  }

  /**
   * Soporte táctil básico: trata el primer toque como hover+click
   * para dispositivos móviles / tablets en planta.
   */
  private handleTouchStart(event: TouchEvent): void {
    if (!this.enabled) return;
    if (event.touches.length === 0) return;

    // Prevenir scroll/zoom del navegador durante interacción
    event.preventDefault();

    const touch = event.touches[0];
    this.updateMouseFromClient(touch.clientX, touch.clientY);
    const intersection = this.raycast();

    if (intersection) {
      const { target, instanceIndex } = intersection;
      const data = target.resolver(instanceIndex);
      if (data) {
        this.eventBus.emit(
          target.onClickEvent,
          { slot: data } as never,
        );
      }
    }
  }

  // ─── Raycasting ─────────────────────────────────────────────────

  /** Actualiza las coordenadas normalizadas del mouse desde un MouseEvent */
  private updateMouse(event: MouseEvent): void {
    const rect = this.domElement.getBoundingClientRect();
    this.updateMouseFromClient(event.clientX, event.clientY, rect);
  }

  /** Actualiza las coordenadas normalizadas desde clientX/clientY */
  private updateMouseFromClient(
    clientX: number,
    clientY: number,
    rect?: DOMRect,
  ): void {
    const r = rect ?? this.domElement.getBoundingClientRect();
    this.mouse.x = ((clientX - r.left) / r.width) * 2 - 1;
    this.mouse.y = -((clientY - r.top) / r.height) * 2 + 1;
  }

  /**
   * Dispara el raycaster contra todos los targets registrados.
   * Retorna la intersección más cercana a la cámara, o null.
   */
  private raycast(): {
    target: InteractiveTarget;
    instanceIndex: number;
  } | null {
    this.raycaster.setFromCamera(this.mouse, this.camera);

    let closestDistance = Infinity;
    let closestResult: {
      target: InteractiveTarget;
      instanceIndex: number;
    } | null = null;

    for (const target of this.targets) {
      const intersects = this.raycaster.intersectObject(target.mesh, false);

      if (intersects.length > 0) {
        const hit = intersects[0];
        if (hit.distance < closestDistance) {
          closestDistance = hit.distance;
          closestResult = {
            target,
            instanceIndex: hit.instanceId!,
          };
        }
      }
    }

    return closestResult;
  }

  // ─── Utilidades ─────────────────────────────────────────────────

  private getSlotIdFromTarget(hovered: {
    target: InteractiveTarget;
    instanceIndex: number;
  }): string {
    const data = hovered.target.resolver(hovered.instanceIndex) as
      | { id?: string }
      | null;
    return data?.id ?? `unknown-${hovered.instanceIndex}`;
  }
}
