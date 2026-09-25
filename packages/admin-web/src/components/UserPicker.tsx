import { useEffect, useId, useRef, useState } from 'react';
import type { Member } from '../api/types';
import { useApi } from '../api/ApiContext';
import { errorMessage } from '../lib/useAsync';

interface UserPickerProps {
  id: string;
  label: string;
  value: Member | null;
  onChange: (member: Member | null) => void;
  required?: boolean;
  error?: string;
  disabled?: boolean;
  /** Retardo del debounce en ms. */
  debounceMs?: number;
}

/** Selector de usuario del directorio: busca en `/admin/users?search=` con debounce. */
export function UserPicker({
  id,
  label,
  value,
  onChange,
  required,
  error,
  disabled,
  debounceMs = 300,
}: UserPickerProps) {
  const api = useApi();
  const listId = useId();
  const errorId = `${id}-error`;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Member[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    const id = ++seq.current;
    setSearching(true);
    const timer = setTimeout(() => {
      api.searchUsers(q).then(
        (users) => {
          if (seq.current !== id) return;
          setResults(users);
          setSearchError(null);
          setSearching(false);
          setActiveIndex(users.length > 0 ? 0 : -1);
        },
        (err: unknown) => {
          if (seq.current !== id) return;
          setSearchError(errorMessage(err));
          setSearching(false);
        },
      );
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [query, api, debounceMs]);

  const select = (m: Member) => {
    onChange(m);
    setQuery('');
    setResults([]);
    setOpen(false);
  };

  if (value) {
    return (
      <div className="field">
        <span className="label">{label}</span>
        <div className="user-chip" data-testid={`${id}-selected`}>
          <span className="user-chip-name">{value.name}</span>
          <span className="user-chip-upn">{value.upn}</span>
          {!disabled && (
            <button
              type="button"
              className="btn btn-link"
              onClick={() => onChange(null)}
              aria-label={`Quitar ${value.name}`}
            >
              Cambiar
            </button>
          )}
        </div>
        {error && (
          <p id={errorId} className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="field user-picker">
      <label htmlFor={id} className="label">
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      <input
        id={id}
        type="search"
        role="combobox"
        autoComplete="off"
        placeholder="Buscar por nombre o correo…"
        value={query}
        disabled={disabled}
        aria-expanded={open && results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIndex((i) => Math.min(i + 1, results.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            const m = results[activeIndex];
            if (m) {
              e.preventDefault();
              select(m);
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open && (searching || searchError || results.length > 0 || query.trim().length >= 2) && (
        <ul id={listId} role="listbox" className="user-picker-list" aria-label="Resultados">
          {searching && (
            <li className="user-picker-hint" aria-live="polite">
              Buscando…
            </li>
          )}
          {!searching && searchError && (
            <li className="user-picker-hint field-error" role="alert">
              {searchError}
            </li>
          )}
          {!searching && !searchError && results.length === 0 && query.trim().length >= 2 && (
            <li className="user-picker-hint">Sin resultados</li>
          )}
          {results.map((m, i) => (
            <li
              key={m.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              className={i === activeIndex ? 'active' : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                select(m);
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              <span className="user-chip-name">{m.name}</span>
              <span className="user-chip-upn">{m.upn}</span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p id={errorId} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
