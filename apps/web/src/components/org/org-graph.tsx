"use client";

import { ArrowRight, Ban, CalendarClock, Check, Gauge, History, Layers, Maximize2, Minus, Plus, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { OrgRole, OrgWeb } from "@/lib/client-api";
import { cn } from "@/lib/utils";

const NW = 232; // node width
const NH = 92; // node height
const GX = 28; // horizontal gap between sibling subtrees
const GY = 120; // vertical gap between levels
const PAD = 48; // canvas padding
const BOX = 22; // department box padding around its nodes

type Placed = { role: OrgRole; x: number; y: number; depth: number };

/** Tidy tree: leaves side by side, each parent centred over its children. */
function layout(roles: OrgRole[]) {
  const ids = new Set(roles.map((r) => r.id));
  const kids = new Map<string, OrgRole[]>();
  for (const r of roles) {
    if (r.parent_id && ids.has(r.parent_id)) kids.set(r.parent_id, [...(kids.get(r.parent_id) ?? []), r]);
  }
  const roots = roles.filter((r) => !r.parent_id || !ids.has(r.parent_id));
  const placed = new Map<string, Placed>();
  let cursor = 0;
  const place = (r: OrgRole, depth: number): number => {
    const children = kids.get(r.id) ?? [];
    let x: number;
    if (!children.length) {
      x = cursor;
      cursor += NW + GX;
    } else {
      const xs = children.map((c) => place(c, depth + 1));
      x = (xs[0] + xs[xs.length - 1]) / 2;
    }
    placed.set(r.id, { role: r, x: x + PAD, y: PAD + 26 + depth * (NH + GY), depth });
    return x;
  };
  for (const r of roots) {
    place(r, 0);
    cursor += GX * 2;
  }
  const all = [...placed.values()];
  const width = Math.max(...all.map((p) => p.x + NW), NW) + PAD;
  const height = Math.max(...all.map((p) => p.y + NH), NH) + PAD;
  return { placed, kids, width, height };
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function OrgGraph({ org, myRoleIds }: { org: OrgWeb; myRoleIds: string[] }) {
  const t = useTranslations("org");
  const { placed, kids, width, height } = useMemo(() => layout(org.roles), [org.roles]);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [dragging, setDragging] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null);
  const titles = useMemo(() => new Map(org.roles.map((r) => [r.id, r.title])), [org.roles]);
  const mine = useMemo(() => new Set(myRoleIds), [myRoleIds]);

  const fit = useCallback(() => {
    const el = frame.current;
    if (!el) return;
    const k = Math.min(el.clientWidth / width, el.clientHeight / height, 1.1);
    setView({ k, x: (el.clientWidth - width * k) / 2, y: (el.clientHeight - height * k) / 2 });
  }, [width, height]);

  useEffect(() => {
    fit();
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit]);

  // Ctrl/⌘ + wheel (and trackpad pinch) zooms around the pointer; plain wheel scrolls the page.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((v) => {
        const k = Math.min(2.2, Math.max(0.35, v.k * Math.exp(-e.deltaY * 0.0025)));
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoom = (factor: number) => {
    const el = frame.current;
    if (!el) return;
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    setView((v) => {
      const k = Math.min(2.2, Math.max(0.35, v.k * factor));
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });
  };

  // Highlight: the selected node, its chain up to the root, and its whole team below.
  const focus = useMemo(() => {
    if (!selected) return null;
    const set = new Set<string>([selected]);
    let p = placed.get(selected)?.role.parent_id;
    while (p && placed.has(p)) {
      set.add(p);
      p = placed.get(p)?.role.parent_id;
    }
    const stack = [...(kids.get(selected) ?? [])];
    while (stack.length) {
      const c = stack.pop()!;
      set.add(c.id);
      stack.push(...(kids.get(c.id) ?? []));
    }
    return set;
  }, [selected, placed, kids]);

  const boxes = org.departments
    .map((d) => {
      const nodes = [...placed.values()].filter((p) => p.role.department_id === d.id);
      if (!nodes.length) return null;
      const x0 = Math.min(...nodes.map((n) => n.x)) - BOX;
      const y0 = Math.min(...nodes.map((n) => n.y)) - BOX - 18;
      const x1 = Math.max(...nodes.map((n) => n.x + NW)) + BOX;
      const y1 = Math.max(...nodes.map((n) => n.y + NH)) + BOX;
      const open = nodes.reduce((n, p) => n + p.role.open_cards, 0);
      return { d, x0, y0, w: x1 - x0, h: y1 - y0, open };
    })
    .filter((b) => b !== null);

  const edges = [...placed.values()]
    .filter((p) => p.role.parent_id && placed.has(p.role.parent_id))
    .map((child) => {
      const parent = placed.get(child.role.parent_id!)!;
      const px = parent.x + NW / 2;
      const py = parent.y + NH;
      const cx = child.x + NW / 2;
      const cy = child.y;
      const my = (py + cy) / 2;
      return {
        id: child.role.id,
        d: `M${px},${py} C${px},${my} ${cx},${my} ${cx},${cy}`,
        mid: { x: (px + cx) / 2, y: my },
        routes: child.role.cards_route_to === parent.role.id,
        flowing: child.role.open_cards_subtree > 0,
        dim: focus !== null && !(focus.has(child.role.id) && focus.has(parent.role.id)),
      };
    });

  const sel = selected ? placed.get(selected)?.role : undefined;

  return (
    <div className="relative">
      <div
        ref={frame}
        className={cn(
          "org-canvas relative h-[min(76vh,48rem)] min-h-[26rem] touch-none select-none overflow-hidden rounded-2xl bg-surface shadow-card",
          dragging ? "cursor-grabbing" : "cursor-grab",
        )}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("[data-node],[data-control]")) return;
          drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const g = drag.current;
          if (!g) return;
          const dx = e.clientX - g.x;
          const dy = e.clientY - g.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) g.moved = true;
          setView((v) => ({ ...v, x: g.vx + dx, y: g.vy + dy }));
        }}
        onPointerUp={() => {
          if (drag.current && !drag.current.moved) setSelected(null); // click on empty canvas
          drag.current = null;
          setDragging(false);
        }}
      >
        <div
          className={cn("absolute left-0 top-0 origin-top-left", !dragging && "transition-transform duration-500 ease-out")}
          style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
        >
          {boxes.map((b, i) => (
            <div
              key={b.d.id}
              className="animate-fade absolute rounded-3xl border border-border/80 bg-background/55 backdrop-blur-[1px]"
              style={{ left: b.x0, top: b.y0, width: b.w, height: b.h, animationDelay: `${i * 120}ms` }}
            >
              <div className="flex items-center justify-between px-5 pt-3 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                <span>{b.d.name}</span>
                <span className="tabular-nums">{t("openCount", { count: b.open })}</span>
              </div>
            </div>
          ))}

          <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={width} height={height} aria-hidden>
            <defs>
              <marker id="route-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className="fill-foreground" />
              </marker>
            </defs>
            {edges.map((e) => (
              <g key={e.id} className={cn("transition-opacity duration-300", e.dim && "opacity-25")}>
                <path d={e.d} fill="none" className="stroke-border" strokeWidth={e.routes ? 1.5 : 2} strokeDasharray={e.routes ? "5 5" : undefined} />
                {e.flowing && (
                  <path
                    d={e.d}
                    fill="none"
                    className="edge-flow stroke-foreground"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    strokeDasharray="2 12"
                    markerStart={e.routes ? "url(#route-arrow)" : undefined}
                  />
                )}
              </g>
            ))}
          </svg>

          {edges
            .filter((e) => e.routes)
            .map((e) => (
              <span
                key={`label-${e.id}`}
                className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-foreground px-2 py-0.5 text-[10px] font-medium text-background shadow-card"
                style={{ left: e.mid.x, top: e.mid.y }}
              >
                {t("routesCards")}
              </span>
            ))}

          {[...placed.values()].map((p, i) => {
            const r = p.role;
            const vacant = r.holder_type === "vacant";
            const isSel = selected === r.id;
            const dim = focus !== null && !focus.has(r.id);
            return (
              <button
                key={r.id}
                type="button"
                data-node
                onClick={() => setSelected(isSel ? null : r.id)}
                aria-pressed={isSel}
                aria-label={`${r.title}, ${vacant ? t("vacant") : r.holders.join(", ")}, ${t("openCount", { count: r.open_cards })}`}
                className={cn("absolute text-left transition-opacity duration-300", dim && "opacity-40")}
                style={{ left: p.x, top: p.y, width: NW, height: NH }}
              >
                <span
                  className="org-float block h-full"
                  style={{ animationDelay: `${(i % 5) * -1.3}s`, animationDuration: `${6 + (i % 3)}s` }}
                >
                  <span
                    className={cn(
                      "flex h-full items-center gap-3 rounded-2xl px-3.5 transition-all duration-300 hover:-translate-y-1 hover:shadow-card-hover",
                      vacant
                        ? "border-2 border-dashed border-muted-foreground/45 bg-background/80"
                        : "bg-card shadow-card",
                      isSel && "ring-2 ring-foreground ring-offset-2 ring-offset-surface",
                    )}
                  >
                    <span
                      className={cn(
                        "relative flex size-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
                        vacant ? "border-2 border-dashed border-muted-foreground/50 text-muted-foreground" : "bg-foreground text-background",
                      )}
                    >
                      {vacant ? "?" : initials(r.holders[0] ?? r.title)}
                      {r.open_cards > 0 && (
                        <span className="absolute -right-1 -top-1 flex size-2.5">
                          <span className="absolute inline-flex size-full animate-ping rounded-full bg-foreground/50" />
                          <span className="relative inline-flex size-2.5 rounded-full border-2 border-card bg-foreground" />
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-semibold">{r.title}</span>
                        {mine.has(r.id) && (
                          <span className="rounded-full bg-surface-strong px-1.5 text-[9px] font-semibold uppercase tracking-wider">
                            {t("you")}
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {vacant
                          ? r.cards_route_to
                            ? t("routesTo", { role: titles.get(r.cards_route_to) ?? "" })
                            : t("vacant")
                          : r.holders.join(", ")}
                      </span>
                      <span className="mt-1.5 flex items-center gap-1.5 text-[11px] tabular-nums">
                        <span
                          className={cn(
                            "rounded-full px-1.5 py-px font-semibold",
                            r.open_cards ? "bg-soft-violet text-iris" : "bg-surface text-muted-foreground",
                          )}
                        >
                          {t("openCount", { count: r.open_cards })}
                        </span>
                        {r.open_cards_subtree > r.open_cards && (
                          <span className="text-muted-foreground">{t("teamCount", { count: r.open_cards_subtree })}</span>
                        )}
                        {r.cadence === "daily" && (
                          <CalendarClock className="ml-auto size-3.5 text-muted-foreground" aria-label={t("daily")} />
                        )}
                      </span>
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div data-control className="absolute left-3 top-3 flex flex-col overflow-hidden rounded-xl bg-card shadow-card">
          <ControlButton label={t("zoomIn")} onClick={() => zoom(1.2)}>
            <Plus className="size-4" />
          </ControlButton>
          <ControlButton label={t("zoomOut")} onClick={() => zoom(1 / 1.2)}>
            <Minus className="size-4" />
          </ControlButton>
          <ControlButton label={t("fit")} onClick={() => fit()}>
            <Maximize2 className="size-4" />
          </ControlButton>
        </div>

        <div
          data-control
          className="absolute bottom-3 left-3 right-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl bg-card/90 px-3 py-2 text-[11px] text-muted-foreground shadow-card backdrop-blur sm:right-auto"
        >
          <span className="flex items-center gap-1.5">
            <span className="size-3 rounded bg-foreground" /> {t("legendFilled")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-3 rounded border-2 border-dashed border-muted-foreground/60" /> {t("legendVacant")}
          </span>
          <span className="flex items-center gap-1.5">
            <svg width="22" height="6" aria-hidden>
              <line x1="0" y1="3" x2="22" y2="3" className="edge-flow stroke-foreground" strokeWidth="1.5" strokeDasharray="2 5" />
            </svg>
            {t("legendFlow")}
          </span>
          <span className="hidden md:inline">{t("hintPan")} · {t("pickHint2")}</span>
        </div>
      </div>

      {sel && (
        <div className="z-10 mt-4 xl:absolute xl:right-3 xl:top-3 xl:mt-0 xl:max-h-[calc(100%-1.5rem)] xl:w-[22rem] xl:overflow-y-auto xl:rounded-2xl">
          <RolePanel role={sel} titles={titles} onClose={() => setSelected(null)} />
        </div>
      )}
    </div>
  );
}

function ControlButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="p-2 text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
    >
      {children}
    </button>
  );
}

function RolePanel({
  role,
  titles,
  onClose,
}: {
  role: OrgRole;
  titles: Map<string, string>;
  onClose: () => void;
}) {
  const t = useTranslations("org");
  const vacant = role.holder_type === "vacant";
  return (
    <aside key={role.id} className="animate-rise space-y-5 rounded-2xl bg-surface/95 p-5 shadow-card-hover backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{t("roleNode")}</p>
          <h2 className="text-lg font-semibold tracking-tight">{role.title}</h2>
          <p className="text-sm text-muted-foreground">
            {vacant
              ? role.cards_route_to
                ? `${t("vacant")} · ${t("routesTo", { role: titles.get(role.cards_route_to) ?? "" })}`
                : t("vacant")
              : role.holders.join(", ")}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label={t("close")} className="rounded-lg p-1.5 text-muted-foreground hover:bg-card hover:text-foreground">
          <X className="size-4" />
        </button>
      </div>

      <dl className="grid grid-cols-3 gap-2 text-center">
        {[
          [t("ownOpen"), role.open_cards],
          [t("teamOpen"), role.open_cards_subtree],
          [t("cadence"), t(role.cadence === "daily" ? "cadence_daily" : "cadence_weekly")],
        ].map(([label, value]) => (
          <div key={String(label)} className="rounded-xl bg-card px-2 py-2 shadow-card">
            <dt className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
            <dd className="mt-0.5 text-sm font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>

      {(role.metrics ?? []).length > 0 && (
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold">
            <Gauge className="size-3.5" aria-hidden /> {t("metrics")}
          </h3>
          <ul className="space-y-1.5">
            {role.metrics.map((m) => (
              <li key={m.key} className="flex items-center justify-between gap-2 rounded-lg bg-card px-3 py-2 text-sm shadow-card">
                <span className="min-w-0 truncate">{m.name}</span>
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                  {m.threshold !== null && <span>{t("thresholdShort", { value: m.threshold, unit: m.unit })}</span>}
                  {m.daily_check && <span className="rounded-full bg-foreground px-1.5 text-background">{t("dailyCheck")}</span>}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(role.decisions_owned ?? []).length > 0 && (
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold">
            <Check className="size-3.5" aria-hidden /> {t("decides")}
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {role.decisions_owned.map((d) => (
              <span key={d} className="rounded-full bg-card px-2.5 py-1 text-xs shadow-card">
                {d}
              </span>
            ))}
          </div>
        </section>
      )}
      {(role.decisions_forbidden ?? []).length > 0 && (
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold">
            <Ban className="size-3.5" aria-hidden /> {t("mayNot")}
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {role.decisions_forbidden.map((d) => (
              <span key={d} className="rounded-full border border-foreground/30 px-2.5 py-1 text-xs text-muted-foreground line-through decoration-foreground/30">
                {d}
              </span>
            ))}
          </div>
        </section>
      )}
      {role.kpi_notes && (
        <p className="rounded-xl bg-card p-3 text-xs leading-relaxed text-muted-foreground shadow-card">
          <span className="font-semibold text-foreground">{t("kpis")}: </span>
          {role.kpi_notes}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Link
          href={`/cards?role=${role.id}`}
          className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3.5 py-2 text-xs font-medium text-background transition-transform hover:-translate-y-px"
        >
          <Layers className="size-3.5" aria-hidden /> {t("openCards")} <ArrowRight className="size-3.5" aria-hidden />
        </Link>
        <Link
          href={`/history?role=${role.id}`}
          className="inline-flex items-center gap-1.5 rounded-full bg-card px-3.5 py-2 text-xs font-medium shadow-card transition-transform hover:-translate-y-px"
        >
          <History className="size-3.5" aria-hidden /> {t("history")}
        </Link>
      </div>
    </aside>
  );
}
