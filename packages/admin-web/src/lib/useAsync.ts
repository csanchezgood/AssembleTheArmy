import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  /** Sustituye los datos localmente (p. ej. tras una escritura). */
  setData: (updater: T | ((prev: T | null) => T | null)) => void;
}

export const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : 'Error desconocido';

/** Ejecuta `fn` al montar y cuando cambian `deps`; ignora resultados obsoletos. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const runId = useRef(0);

  useEffect(() => {
    const id = ++runId.current;
    setLoading(true);
    setError(null);
    fn().then(
      (result) => {
        if (runId.current !== id) return;
        setDataState(result);
        setLoading(false);
      },
      (err: unknown) => {
        if (runId.current !== id) return;
        setError(errorMessage(err));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const setData = useCallback((updater: T | ((prev: T | null) => T | null)) => {
    setDataState((prev) => (typeof updater === 'function' ? (updater as (p: T | null) => T | null)(prev) : updater));
  }, []);

  return { data, error, loading, reload, setData };
}
