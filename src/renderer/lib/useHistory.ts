import { useCallback, useRef, useState } from 'react';

const LIMIT = 100;

/**
 * State with undo/redo. `set(next, { transient: true })` skips the history entry, for continuous
 * gestures like dragging; call `checkpoint()` once when the gesture starts.
 */
export function useHistory<T>(initial: T) {
  const [present, setPresent] = useState(initial);
  const presentRef = useRef(initial);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const [, forceRender] = useState(0);

  const commit = (next: T) => {
    presentRef.current = next;
    setPresent(next);
  };

  const checkpoint = useCallback(() => {
    past.current = [...past.current.slice(-LIMIT + 1), presentRef.current];
    future.current = [];
    forceRender((value) => value + 1);
  }, []);

  const set = useCallback(
    (update: T | ((current: T) => T), options: { transient?: boolean } = {}) => {
      const next = typeof update === 'function' ? (update as (current: T) => T)(presentRef.current) : update;
      if (Object.is(next, presentRef.current)) {
        return;
      }
      if (!options.transient) {
        checkpoint();
      }
      commit(next);
    },
    [checkpoint]
  );

  /** Replace state and clear history (new/open project). */
  const reset = useCallback((next: T) => {
    past.current = [];
    future.current = [];
    commit(next);
  }, []);

  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (previous === undefined) {
      return;
    }
    future.current.push(presentRef.current);
    commit(previous);
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next === undefined) {
      return;
    }
    past.current.push(presentRef.current);
    commit(next);
  }, []);

  return {
    state: present,
    /** Always-current value, for use inside callbacks. */
    ref: presentRef,
    set,
    reset,
    checkpoint,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0
  };
}
