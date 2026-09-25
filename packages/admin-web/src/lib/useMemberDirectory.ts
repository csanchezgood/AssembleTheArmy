import { useMemo } from 'react';
import { useApi } from '../api/ApiContext';
import type { Member } from '../api/types';
import { useAsync, type AsyncState } from './useAsync';

export type MemberDirectory = Map<string, Member>;

/**
 * Directorio `member_id → Member` construido a partir de todas las guardias.
 * `AvailabilityItem` solo guarda `member_id`, así que se usa para mostrar nombre y UPN.
 */
export function useMemberDirectory(): AsyncState<MemberDirectory> {
  const api = useApi();
  return useAsync(async () => {
    const systems = await api.listSystems();
    const rosters = await Promise.all(systems.map((s) => api.listRoster(s.system_id)));
    const map: MemberDirectory = new Map();
    for (const items of rosters) {
      for (const item of items) {
        if (!map.has(item.member_id)) {
          map.set(item.member_id, { id: item.member_id, upn: item.member_upn, name: item.member_name });
        }
      }
    }
    return map;
  }, [api]);
}

export function useSortedMembers(directory: MemberDirectory | null): Member[] {
  return useMemo(
    () => (directory ? [...directory.values()].sort((a, b) => a.name.localeCompare(b.name)) : []),
    [directory],
  );
}
