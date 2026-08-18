// ─── EventBus Tipado ───────────────────────────────────────────────
// Sistema nervioso central del gemelo digital.
// Desacopla completamente la capa 3D de la capa UI usando pub/sub tipado.
//
// Características:
//  - Tipado estricto: emit('entity:clicked', { wrongKey: 1 }) no compila.
//  - Debug mode: traza cada evento emitido y listeners registrados.
//  -once: listeners que se auto-eliminan tras la primera ejecución.
//  - Prevención de fugas: dispose() limpia todos los listeners de una vez.

import type {
  EventMap,
  EventName,
  EventListener,
  ListenerId,
  ListenerEntry,
} from '../types/events.ts';

// ─── Utilidades internas ───────────────────────────────────────────

let _idCounter = 0;
function generateId(): ListenerId {
  _idCounter += 1;
  return `listener_${_idCounter}_${Date.now().toString(36)}`;
}

// ─── Clase Principal ───────────────────────────────────────────────

export class EventBus {
  /** Registro de listeners indexados por nombre de evento */
  private readonly listeners = new Map<EventName, ListenerEntry[]>();

  /** Si es true, imprime cada emit/register/unregister en consola */
  private debugMode: boolean;

  /** Si es true, el bus fue destruido y rechaza operaciones */
  private disposed: boolean;

  constructor(options?: { debug?: boolean }) {
    this.debugMode = options?.debug ?? false;
    this.disposed = false;
  }

  // ─── Registro ──────────────────────────────────────────────────

  /**
   * Registra un listener para un evento específico.
   * Retorna el ID del listener para poder removerlo después con off().
   *
   * @example
   * const id = bus.on('entity:clicked', ({ equipment }) => {
   *   console.log(equipment.name);
   * });
   */
  on<E extends EventName>(event: E, callback: EventListener<E>): ListenerId {
    this.assertNotDisposed();

    const id = generateId();
    const entry: ListenerEntry<E> = {
      id,
      event,
      callback,
      once: false,
    };

    const existing = this.listeners.get(event) ?? [];
    existing.push(entry as unknown as ListenerEntry);
    this.listeners.set(event, existing);

    if (this.debugMode) {
      console.debug(
        `[EventBus] on("${event}") → ${id} (total: ${existing.length})`,
      );
    }

    return id;
  }

  /**
   * Registra un listener que se ejecuta UNA sola vez y luego se auto-elimina.
   */
  once<E extends EventName>(event: E, callback: EventListener<E>): ListenerId {
    this.assertNotDisposed();

    const id = generateId();
    const entry: ListenerEntry<E> = {
      id,
      event,
      callback,
      once: true,
    };

    const existing = this.listeners.get(event) ?? [];
    existing.push(entry as unknown as ListenerEntry);
    this.listeners.set(event, existing);

    if (this.debugMode) {
      console.debug(
        `[EventBus] once("${event}") → ${id} (total: ${existing.length})`,
      );
    }

    return id;
  }

  // ─── Eliminación ───────────────────────────────────────────────

  /**
   * Elimina un listener específico usando el ID retornado por on()/once().
   * No hace nada si el ID no existe.
   */
  off(id: ListenerId): void {
    if (this.disposed) return;

    for (const [event, entries] of this.listeners.entries()) {
      const index = entries.findIndex((e) => e.id === id);
      if (index !== -1) {
        entries.splice(index, 1);

        if (this.debugMode) {
          console.debug(
            `[EventBus] off("${event}") × ${id} (quedan: ${entries.length})`,
          );
        }

        // Limpiar arrays vacíos para no acumular claves
        if (entries.length === 0) {
          this.listeners.delete(event);
        }
        return;
      }
    }
  }

  /**
   * Elimina todos los listeners de un evento específico.
   */
  offAll(event: EventName): void {
    if (this.disposed) return;

    const removed = this.listeners.get(event)?.length ?? 0;
    this.listeners.delete(event);

    if (this.debugMode && removed > 0) {
      console.debug(`[EventBus] offAll("${event}") × ${removed}`);
    }
  }

  // ─── Emisión ───────────────────────────────────────────────────

  /**
   * Emite un evento a todos los listeners registrados para ese nombre.
   * El payload está totalmente tipado según EventMap.
   *
   * @example
   * bus.emit('entity:clicked', { equipment: myEquipment });
   * bus.emit('engine:ready'); // void payload — sin argumento
   */
  emit<E extends EventName>(
    event: E,
    ...[payload]: EventMap[E] extends void ? [] : [payload: EventMap[E]]
  ): void {
    if (this.disposed) {
      if (this.debugMode) {
        console.warn(`[EventBus] emit("${event}") ignorado: bus destruido`);
      }
      return;
    }

    const entries = this.listeners.get(event);
    if (!entries || entries.length === 0) {
      if (this.debugMode) {
        console.debug(
          `[EventBus] emit("${event}") → 0 listeners`,
          payload,
        );
      }
      return;
    }

    // Copia superficial para evitar mutaciones durante la iteración
    // (un listener podría registrar/eliminar listeners en cadena)
    const snapshot = [...entries];

    if (this.debugMode) {
      console.debug(
        `[EventBus] emit("${event}") → ${snapshot.length} listeners`,
        payload,
      );
    }

    for (const entry of snapshot) {
      try {
        (entry.callback as unknown as EventListener<E>)(payload as EventMap[E]);
      } catch (error) {
        console.error(
          `[EventBus] Error en listener ${entry.id} para "${event}":`,
          error,
        );
      }
    }

    // Limpiar listeners "once" después de la iteración
    const remaining = entries.filter((e) => !e.once);
    if (remaining.length === 0) {
      this.listeners.delete(event);
    } else {
      this.listeners.set(event, remaining);
    }
  }

  // ─── Utilidades ────────────────────────────────────────────────

  /** Cantidad total de listeners registrados */
  get listenerCount(): number {
    let count = 0;
    for (const entries of this.listeners.values()) {
      count += entries.length;
    }
    return count;
  }

  /** Lista de eventos que tienen al menos un listener */
  get activeEvents(): EventName[] {
    return [...this.listeners.keys()];
  }

  /** Activa/desactiva el modo debug */
  setDebug(enabled: boolean): void {
    this.debugMode = enabled;
  }

  // ─── Ciclo de Vida ─────────────────────────────────────────────

  /**
   * Destruye el bus: elimina TODOS los listeners y marca como disposed.
   * Llamar a esto al desmontar la aplicación o cambiar de escena.
   */
  dispose(): void {
    if (this.disposed) return;

    const totalListeners = this.listenerCount;
    this.listeners.clear();
    this.disposed = true;

    if (this.debugMode) {
      console.debug(
        `[EventBus] dispose() — ${totalListeners} listeners eliminados`,
      );
    }
  }

  /** El bus fue destruido y rechaza nuevas operaciones */
  get isDisposed(): boolean {
    return this.disposed;
  }

  // ─── Privado ───────────────────────────────────────────────────

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(
        '[EventBus] No se puede operar sobre un bus destruido. ' +
          'Crea una nueva instancia o llama a dispose() solo al final del ciclo de vida.',
      );
    }
  }
}
