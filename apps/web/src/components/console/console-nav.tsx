"use client";

import { Bot, Building2, FlaskConical, ChevronsUpDown, LayoutGrid, ListChecks, Scale, Search, SlidersHorizontal, Users } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { NavLink } from "@/components/nav-link";
import { cn } from "@/lib/utils";

// A workspace's own pages belong to the item they are about: its onboarding steps to Onboarding,
// the workspace home and its runs to Overview.
const LINKS: { href: string; label: string; icon: typeof LayoutGrid; exact?: boolean; match?: RegExp }[] = [
  { href: "/console", label: "Overview", icon: LayoutGrid, exact: true, match: /^\/console\/workspaces\/[^/]+(\/runs\/.*)?$/ },
  { href: "/console/onboarding", label: "Onboarding", icon: ListChecks, match: /^\/console\/workspaces\/[^/]+\/onboarding/ },
  { href: "/console/config", label: "Config & rules", icon: SlidersHorizontal },
  { href: "/console/agents", label: "AI agents", icon: Bot },
  { href: "/console/ai-lab", label: "AI lab", icon: FlaskConical },
  { href: "/console/rules", label: "Rule review", icon: Scale },
  { href: "/console/team", label: "Team", icon: Users },
];

function Count({ n }: { n: number }) {
  return <span className="rounded-full bg-iris px-1.5 text-[10px] font-bold text-white tabular-nums">{n}</span>;
}

/** The console navigation, in the same style as the client sidebar. */
export function ConsoleNav({ rulesToReview, onboardingQuestions = 0 }: { rulesToReview: number; onboardingQuestions?: number }) {
  return (
    <nav className="mt-6" aria-label="Console">
      <p className="eyebrow sb-eyebrow mb-[7px] ml-[11px]">Internal</p>
      {LINKS.map(({ href, label, icon: Icon, exact, match }) => (
        <NavLink
          key={href}
          href={href}
          exact={exact}
          match={match}
          icon={<Icon size={19} aria-hidden />}
          badge={
            href === "/console/onboarding" && onboardingQuestions > 0 ? (
              <Count n={onboardingQuestions} />
            ) : href === "/console/rules" && rulesToReview > 0 ? (
              <Count n={rulesToReview} />
            ) : undefined
          }
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

/** Jump to any workspace by name. Type to filter; Enter opens the first match. The list is fixed to
 * the screen, so it still opens when the sidebar is collapsed. */
export function WorkspaceSwitcher({ workspaces }: { workspaces: { id: string; name: string; health: string }[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const currentId = pathname.match(/^\/console\/workspaces\/([^/]+)/)?.[1];
  const current = workspaces.find((w) => w.id === currentId);
  const shown = useMemo(() => workspaces.filter((w) => w.name.toLowerCase().includes(q.toLowerCase())), [workspaces, q]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const toggle = () => {
    const r = trigger.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 8, left: Math.min(r.left, window.innerWidth - 304) });
    setOpen((o) => !o);
  };
  const go = (id: string) => {
    setOpen(false);
    setQ("");
    router.push(`/console/workspaces/${id}`);
  };

  return (
    <div ref={box} className="mt-6">
      <button
        ref={trigger}
        type="button"
        onClick={toggle}
        aria-expanded={open}
        title={current?.name ?? "All workspaces"}
        className="sb-card flex w-full min-w-0 items-center gap-2.5 rounded-[14px] border border-border bg-surface p-[9px] text-left transition-colors hover:bg-soft-violet"
      >
        <span className="grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-ink text-white">
          <Building2 size={17} aria-hidden />
        </span>
        <span className="sb-label min-w-0 flex-1">
          <small className="block text-[11px] text-muted-foreground">Workspace</small>
          <strong className="block truncate text-[13.5px] font-extrabold">{current?.name ?? "All workspaces"}</strong>
        </span>
        <ChevronsUpDown size={16} className="sb-label shrink-0 text-muted-foreground" aria-hidden />
      </button>
      {open && (
        <div
          style={{ top: pos.top, left: pos.left }}
          className="animate-fade fixed z-50 w-72 overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-card-hover"
        >
          <label className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
            <Search size={16} className="text-muted-foreground" aria-hidden />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && shown[0] && go(shown[0].id)}
              placeholder="Search workspaces"
              className="w-full bg-transparent text-sm outline-none"
            />
          </label>
          <ul className="max-h-72 overflow-y-auto p-1.5">
            <li>
              <Link href="/console" onClick={() => setOpen(false)} className="block rounded-xl px-3 py-2 text-sm text-muted-foreground hover:bg-surface">
                All workspaces
              </Link>
            </li>
            {shown.map((w) => (
              <li key={w.id}>
                <button
                  type="button"
                  onClick={() => go(w.id)}
                  className={cn("flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-surface", w.id === currentId && "bg-soft-violet font-semibold text-iris-ink")}
                >
                  <span className={cn("size-2 shrink-0 rounded-full", w.health === "healthy" ? "bg-jade" : "bg-iris")} aria-hidden />
                  <span className="truncate">{w.name}</span>
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No match</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
