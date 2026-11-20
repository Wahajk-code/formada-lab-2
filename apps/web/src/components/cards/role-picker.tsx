import { FilterSelect } from "@/components/ui/filter-select";
import { Icon } from "@/components/ui/icon";

/** The active role (design `pageHeader`): a select when there are several roles to look through,
 * otherwise a small context box. The choice rides in the `role` query parameter. */
export function RolePicker({
  roles,
  current,
  label,
  fallback,
}: {
  roles: { id: string; title: string; open: number }[];
  current: string;
  label: string;
  fallback: string;
}) {
  if (roles.length < 2) {
    const only = roles[0];
    return only ? (
      <div className="dw-role-context">
        <Icon name="users" size={18} />
        <div>
          <small>{label}</small>
          <strong>{only.title}</strong>
        </div>
      </div>
    ) : null;
  }
  return <FilterSelect param="role" label={label} value={current} fallback={fallback} options={roles.map((r) => [r.id, r.title])} />;
}
