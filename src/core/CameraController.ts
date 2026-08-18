// ─── Controlador de Cámara ─────────────────────────────────────────
// OrbitControls con límites industriales + transiciones cinemáticas GSAP.
//
// Responsabilidades:
//   - Proveer navegación orbital libre con límites de suelo y distancia.
//   - Ejecutar transiciones animadas precisas (sin flotación) hacia
//     entidades seleccionadas vía focusOnPosition().
//   - Escuchar warehouse:slot-clicked para volar automáticamente al slot.
//   - Sincronizarse con sim:tick para actualizar OrbitControls cada frame.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import gsap from 'gsap';
import type { EventBus } from '../systems/EventBus.ts';

// ─── Constantes ─────────────────────────────────────────────────────

/** Distancia mínima de zoom (evita atravesar geometría). */
const MIN_DISTANCE = 2.5;

/** Distancia máxima de zoom (evita perderse en el vacío). */
const MAX_DISTANCE = 50;

/** Ángulo polar máximo: frena la cámara justo antes del suelo. */
const MAX_POLAR_ANGLE = Math.PI / 2 - 0.05;

/** Ángulo polar mínimo: evita mirar exactamente desde arriba (mantiene perspectiva). */
const MIN_POLAR_ANGLE = 0.15;

/** Velocidad de rotación (radianes por píxel de arrastre). */
const ROTATE_SPEED = 0.6;

/** Factor de amortiguación (inercia). Bajo = respuesta más rápida. */
const DAMPING_FACTOR = 0.08;

/** Duración por defecto de las transiciones cinemáticas (segundos). */
const DEFAULT_FLY_DURATION = 1.1;

/** Offset de cámara al enfocar un slot (relativo al target). */
const FOCUS_OFFSET = new THREE.Vector3(2.5, 2.0, 3.5);

// ─── Tipos ──────────────────────────────────────────────────────────

export type ViewMode = 'top-down' | 'isometric' | 'free-orbit';

export interface FocusOptions {
  /** Duración de la animación en segundos. */
  duration?: number;
  /** Offset de la cámara relativo al punto de interés. */
  offset?: THREE.Vector3;
  /** Easing de GSAP (debe ser preciso, no flotante). */
  ease?: string;
}

/** Callback que resuelve un instanceIndex a una posición en coordenadas mundo. */
export type SlotPositionResolver = (
  instanceIndex: number,
) => THREE.Vector3 | null;

// ─── Vistas predefinidas ────────────────────────────────────────────

const VIEW_PRESETS: Record<
  ViewMode,
  { position: THREE.Vector3; target: THREE.Vector3 }
> = {
  'top-down': {
    position: new THREE.Vector3(0, 18, 0.5),
    target: new THREE.Vector3(0, 1.0, 0.2),
  },
  'isometric': {
    position: new THREE.Vector3(14, 10, 16),
    target: new THREE.Vector3(0, 1.2, 0.2),
  },
  'free-orbit': {
    position: new THREE.Vector3(14, 10, 16),
    target: new THREE.Vector3(0, 1.2, 0.2),
  },
};

// ─── Clase Principal ────────────────────────────────────────────────

export class CameraController {
  readonly controls: OrbitControls;

  private readonly eventBus: EventBus;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly resolveSlotPosition?: SlotPositionResolver;

  /** IDs de listeners del EventBus para cleanup. */
  private readonly listenerIds: string[] = [];

  /** Si hay una animación GSAP en curso. */
  private isAnimating = false;

  /** Timeline GSAP activa (se mata al iniciar una nueva). */
  private activeTween: gsap.core.Timeline | null = null;

  /** Posición y target iniciales de la cámara (para reset). */
  private readonly _initialCameraPos: THREE.Vector3;
  private readonly _initialTarget: THREE.Vector3;

  // ─── Constructor ────────────────────────────────────────────────

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    eventBus: EventBus,
    options?: {
      resolveSlotPosition?: SlotPositionResolver;
    },
  ) {
    this.camera = camera;
    this.eventBus = eventBus;
    this.resolveSlotPosition = options?.resolveSlotPosition;

    // ── OrbitControls ────────────────────────────────────────────
    this.controls = new OrbitControls(camera, domElement);
    this.configureControls();

    // ── Guardar posición inicial para reset ──────────────────────
    this._initialCameraPos = camera.position.clone();
    this._initialTarget = this.controls.target.clone();

    // ── Sincronización con el game loop ──────────────────────────
    // Cada frame, si no hay animación GSAP en curso, actualizamos
    // OrbitControls para procesar input del usuario + damping.
    this.listenerIds.push(
      eventBus.on('sim:tick', () => {
        if (!this.isAnimating) {
          this.controls.update();
        }
      }),
    );

    // ── Click en slot del almacén → volar a la posición ──────────
    // Capturamos el resolver en una constante local para que TypeScript
    // pueda narrow el tipo dentro del callback asíncrono del evento.
    const slotResolver = this.resolveSlotPosition;
    if (slotResolver) {
      this.listenerIds.push(
        eventBus.on('warehouse:slot-clicked', ({ slot }) => {
          const worldPos = slotResolver(slot.instanceIndex);
          if (worldPos) {
            this.focusOnPosition(worldPos);
          }
        }),
      );
    }

    // ── Cambio de modo de vista ──────────────────────────────────
    this.listenerIds.push(
      eventBus.on('ui:view-mode', ({ mode }) => {
        this.setViewMode(mode);
      }),
    );

    // ── Foco desde UI (ej. sidebar de equipos) ───────────────────
    this.listenerIds.push(
      eventBus.on('ui:focus-entity', (_payload) => {
        // Pendiente: convertir _payload.equipmentId → posición mundo
        // y llamar a this.focusOnPosition().
      }),
    );

    // ── Reset de cámara a vista global ───────────────────────────
    this.listenerIds.push(
      eventBus.on('ui:reset-camera', () => {
        this.resetToGlobalView();
      }),
    );
  }

  // ─── API Pública ────────────────────────────────────────────────

  /**
   * Vuela la cámara hacia una posición en el mundo con animación GSAP.
   * La cámara se posiciona con un offset para mantener perspectiva.
   *
   * @param targetPos - Punto del mundo al que mirar.
   * @param options - Opciones de animación (duración, offset, easing).
   */
  focusOnPosition(targetPos: THREE.Vector3, options?: FocusOptions): void {
    const duration = options?.duration ?? DEFAULT_FLY_DURATION;
    const offset = options?.offset ?? FOCUS_OFFSET.clone();
    const ease = options?.ease ?? 'power3.out';

    // Cancelar animación previa si existe
    this.killAnimation();

    // Posición destino de la cámara = target + offset
    const targetCamPos = targetPos.clone().add(offset);

    // ── Objeto proxy para GSAP ───────────────────────────────────
    // GSAP anima propiedades numéricas de un objeto plano.
    // onUpdate sincroniza los valores de vuelta a Three.js.
    const proxy = {
      camX: this.camera.position.x,
      camY: this.camera.position.y,
      camZ: this.camera.position.z,
      targetX: this.controls.target.x,
      targetY: this.controls.target.y,
      targetZ: this.controls.target.z,
    };

    this.isAnimating = true;
    this.controls.enabled = false;

    this.activeTween = gsap.timeline({
      onUpdate: () => {
        this.camera.position.set(proxy.camX, proxy.camY, proxy.camZ);
        this.controls.target.set(
          proxy.targetX,
          proxy.targetY,
          proxy.targetZ,
        );
      },
      onComplete: () => {
        this.isAnimating = false;
        this.controls.enabled = true;
        // Sincronizar estado interno de OrbitControls con la nueva posición
        this.controls.target.set(
          proxy.targetX,
          proxy.targetY,
          proxy.targetZ,
        );
        this.controls.update();
        this.activeTween = null;
      },
    });

    // Animación simultánea de posición de cámara y punto de mira
    this.activeTween.to(
      proxy,
      {
        camX: targetCamPos.x,
        camY: targetCamPos.y,
        camZ: targetCamPos.z,
        targetX: targetPos.x,
        targetY: targetPos.y,
        targetZ: targetPos.z,
        duration,
        ease,
      },
      0, // position = 0: inicia inmediatamente en el timeline
    );
  }

  /**
   * Cambia el modo de vista a uno predefinido.
   * - 'top-down': vista cenital para inspección de layout.
   * - 'isometric': vista 3/4 industrial por defecto.
   * - 'free-orbit': mantiene la posición actual (el usuario ya está en modo libre).
   */
  setViewMode(mode: ViewMode): void {
    if (mode === 'free-orbit') return; // No forzar posición

    const preset = VIEW_PRESETS[mode];
    this.focusOnPosition(preset.target, {
      offset: preset.position.clone().sub(preset.target),
      duration: 1.3,
      ease: 'power2.inOut',
    });
  }

  /**
   * Anima la cámara de regreso a la posición global inicial.
   * Usa el mismo mecanismo GSAP que focusOnPosition para suavidad.
   */
  resetToGlobalView(): void {
    const offset = this._initialCameraPos.clone().sub(this._initialTarget);
    this.focusOnPosition(this._initialTarget.clone(), {
      offset,
      duration: 1.3,
      ease: 'power2.inOut',
    });
  }

  /** Habilita/deshabilita la interacción manual del usuario. */
  setEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
  }

  get enabled(): boolean {
    return this.controls.enabled;
  }

  // ─── Limpieza ──────────────────────────────────────────────────

  dispose(): void {
    // Cancelar animaciones
    this.killAnimation();

    // Remover listeners del EventBus
    for (const id of this.listenerIds) {
      this.eventBus.off(id);
    }
    this.listenerIds.length = 0;

    // OrbitControls se limpia solo (no requiere dispose explícito,
    // pero removemos los event listeners del DOM que registró).
    this.controls.dispose();
  }

  // ─── Configuración Interna ─────────────────────────────────────

  private configureControls(): void {
    const ctrl = this.controls;

    // Límites de distancia
    ctrl.minDistance = MIN_DISTANCE;
    ctrl.maxDistance = MAX_DISTANCE;

    // Límites angulares
    ctrl.maxPolarAngle = MAX_POLAR_ANGLE;  // No atravesar el suelo
    ctrl.minPolarAngle = MIN_POLAR_ANGLE;  // No vertical absoluto
    ctrl.minAzimuthAngle = -Infinity;       // Rotación horizontal libre
    ctrl.maxAzimuthAngle = Infinity;

    // Damping (inercia controlada, respuesta rápida)
    ctrl.enableDamping = true;
    ctrl.dampingFactor = DAMPING_FACTOR;

    // Velocidad de rotación
    ctrl.rotateSpeed = ROTATE_SPEED;

    // Zoom
    ctrl.zoomSpeed = 1.0;

    // Pan (arrastre con botón derecho/medio)
    ctrl.enablePan = true;
    ctrl.panSpeed = 0.8;

    // La cámara mira al target inicial
    ctrl.target.set(0, 1.2, 0.2);
    ctrl.update();
  }

  private killAnimation(): void {
    if (this.activeTween) {
      this.activeTween.kill();
      this.activeTween = null;
    }
    this.isAnimating = false;
    this.controls.enabled = true;
  }
}
