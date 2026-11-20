/** Which dashboard a person sees depends on the level of their active role.
 *
 * The level is decided by the role's archetype in the catalog (`level: executive | mid | low`), so the
 * rule lives in one editable place and nothing is hard-coded here. Meeting rule (2026-11): C-level and
 * presidents are executive, directors are mid, everyone else is low. When an archetype has no level
 * (a custom role), the position in the org web decides: no parent is executive, a role with reports
 * is mid, the rest are low.
 *
 * The three levels share components (tiles, delta pills, department cards, suggestion lists). Within a
 * level only the data changes, so a view is a thin page over `components/dashboard/*` plus a data
 * adapter. The upper view is built; mid and lower fall back to the role dashboard for now.
 */
export type ViewLevel = "upper" | "mid" | "lower";
export type ArchetypeLevel = "executive" | "mid" | "low";

export type OrgRole = { id: string; parent_id: string | null; level?: ArchetypeLevel | null };

const FROM_ARCHETYPE: Record<ArchetypeLevel, ViewLevel> = { executive: "upper", mid: "mid", low: "lower" };

export function viewLevel(roleId: string | null, roles: OrgRole[]): ViewLevel | null {
  if (!roleId) return null;
  const byId = new Map(roles.map((r) => [r.id, r]));
  const role = byId.get(roleId);
  if (!role) return null;
  if (role.level && role.level in FROM_ARCHETYPE) return FROM_ARCHETYPE[role.level];
  if (!role.parent_id || !byId.has(role.parent_id)) return "upper";
  return roles.some((r) => r.parent_id === roleId) ? "mid" : "lower";
}
