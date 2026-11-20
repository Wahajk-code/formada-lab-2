"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";

import { importOrgFile, importOrgTemplate, microsoftConsentUrl, saveOrgDraft } from "@/app/onboarding-actions";
import type { Result } from "@/app/actions";
import { Icon, type IconName } from "@/components/ui/icon";
import type { DraftNode, OrgDraft, OrgTemplate } from "@/lib/client-api";

const ACCEPT = ".png,.jpg,.jpeg,.webp,.heic,.csv,.xlsx,.vsdx,.pptx";
const CARD_W = 164;
const CARD_H = 82;
const X_GAP = 25;
const Y_GAP = 62;
const PAD = 35;

const newId = () => `n${Math.random().toString(36).slice(2, 10)}`;
const initials = (name: string) =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

function descendants(nodes: DraftNode[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (n.parent_id && out.has(n.parent_id) && !out.has(n.id)) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Tree layout (Formada.AI design): each parent centred over its children. */
function treeLayout(nodes: DraftNode[], start: DraftNode) {
  const children = new Map<string | null, DraftNode[]>(nodes.map((n) => [n.id, []]));
  for (const n of nodes) children.get(n.parent_id)?.push(n);
  const points = new Map<string, { x: number; y: number }>();
  let width = 0;
  let height = 0;
  const place = (node: DraftNode, depth: number, left: number): number => {
    let span = 0;
    for (const child of children.get(node.id) ?? []) span += place(child, depth + 1, left + span);
    span = Math.max(CARD_W + X_GAP, span);
    const x = left + (span - CARD_W) / 2;
    const y = PAD + depth * (CARD_H + Y_GAP);
    points.set(node.id, { x, y });
    width = Math.max(width, x + CARD_W + PAD);
    height = Math.max(height, y + CARD_H + PAD);
    return span;
  };
  place(start, 0, PAD - X_GAP / 2);
  return { points, width, height };
}

const curved = (fx: number, fy: number, tx: number, ty: number) => {
  const mid = (fy + ty) / 2;
  return `M ${fx} ${fy} C ${fx} ${mid}, ${tx} ${mid}, ${tx} ${ty}`;
};

// ---------------------------------------------------------------------------------------------
// The canvas: drag to pan, ctrl+wheel or the buttons to zoom
// ---------------------------------------------------------------------------------------------

type Viewport = { zoom: number; x: number; y: number };

function Graph({
  nodes,
  root,
  selected,
  editable,
  onSelect,
  onAdd,
}: {
  nodes: DraftNode[];
  root: DraftNode;
  selected: string | null;
  editable: boolean;
  onSelect: (id: string) => void;
  onAdd: (parent: string) => void;
}) {
  const t = useTranslations("builder");
  const layout = useMemo(() => treeLayout(nodes, root), [nodes, root]);
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<Viewport>({ zoom: 1, x: 0, y: 0 });
  const drag = useRef<{ cx: number; cy: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const fit = useCallback(() => {
    const el = box.current;
    if (!el || !el.clientWidth) return;
    const zoom = Math.max(0.22, Math.min(1, (el.clientWidth - 20) / layout.width, (el.clientHeight - 24) / layout.height));
    setView({ zoom, x: (el.clientWidth - layout.width * zoom) / 2, y: (el.clientHeight - layout.height * zoom) / 2 });
  }, [layout.width, layout.height]);

  const refitKey = `${layout.width}x${layout.height}`;
  useEffect(() => {
    fit();
  }, [fit, refitKey]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const el = box.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    const px = cx == null ? b.width / 2 : cx - b.left;
    const py = cy == null ? b.height / 2 : cy - b.top;
    setView((v) => {
      const zoom = Math.max(0.22, Math.min(1.85, v.zoom * factor));
      return { zoom, x: px - ((px - v.x) * zoom) / v.zoom, y: py - ((py - v.y) * zoom) / v.zoom };
    });
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [zoomAt]);

  const paths = nodes.flatMap((n) => {
    const p = n.parent_id ? layout.points.get(n.parent_id) : null;
    const c = layout.points.get(n.id);
    if (!p || !c) return [];
    return [<path key={n.id} d={curved(p.x + CARD_W / 2, p.y + CARD_H, c.x + CARD_W / 2, c.y)} />];
  });

  return (
    <>
      <div
        ref={box}
        className={`ow-viewport${dragging ? " ow-dragging" : ""}`}
        tabIndex={0}
        aria-label={t("canvasLabel")}
        onPointerDown={(e) => {
          if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
          drag.current = { cx: e.clientX, cy: e.clientY, x: view.x, y: view.y };
          e.currentTarget.setPointerCapture(e.pointerId);
          setDragging(true);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          setView((v) => ({ ...v, x: d.x + e.clientX - d.cx, y: d.y + e.clientY - d.cy }));
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setDragging(false);
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const step: Record<string, [number, number]> = { ArrowLeft: [32, 0], ArrowRight: [-32, 0], ArrowUp: [0, 32], ArrowDown: [0, -32] };
          if (step[e.key]) {
            e.preventDefault();
            setView((v) => ({ ...v, x: v.x + step[e.key][0], y: v.y + step[e.key][1] }));
          }
          if (["+", "=", "-"].includes(e.key)) {
            e.preventDefault();
            zoomAt(e.key === "-" ? 1 / 1.2 : 1.2);
          }
        }}
      >
        <div className="ow-stage" style={{ width: layout.width, height: layout.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
          <svg className="ow-edges" width={layout.width} height={layout.height} aria-hidden="true">
            {paths}
          </svg>
          {nodes
            .filter((n) => layout.points.has(n.id))
            .map((n) => {
              const pt = layout.points.get(n.id)!;
              const vacant = n.vacant || !n.name;
              return (
                <div key={n.id} className={`ow-node${vacant ? " ow-node-vacant" : ""}${n.id === selected ? " ow-node-selected" : ""}`} style={{ left: pt.x, top: pt.y }}>
                  <button className="ow-node-body" type="button" aria-pressed={n.id === selected} title={n.title} onClick={() => onSelect(n.id)}>
                    <span className="ow-node-title">{n.title || t("untitled")}</span>
                    <span className="ow-node-person">
                      <span className={`ow-avatar${vacant ? " ow-avatar-vacant" : ""}`}>{!vacant && n.name ? initials(n.name) : <Icon name="user" size={12} />}</span>
                      <span className="ow-node-person-name">{vacant ? t("vacant") : n.name}</span>
                    </span>
                  </button>
                  {editable && (
                    <button type="button" className="ow-add" title={t("addReport")} aria-label={`${t("addReport")}: ${n.title}`} onClick={() => onAdd(n.id)}>
                      <Icon name="plus" size={13} />
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      </div>
      <div className="ow-canvas-controls">
        <button type="button" className="ow-icon-btn" aria-label={t("zoomOut")} onClick={() => zoomAt(1 / 1.2)}>
          <Icon name="minus" size={17} />
        </button>
        <span className="ow-zoom">{Math.round(view.zoom * 100)}%</span>
        <button type="button" className="ow-icon-btn" aria-label={t("zoomIn")} onClick={() => zoomAt(1.2)}>
          <Icon name="plus" size={17} />
        </button>
        <span className="ow-control-divider" />
        <button type="button" className="ow-icon-btn" aria-label={t("fit")} title={t("fit")} onClick={fit}>
          <Icon name="maximize" size={17} />
        </button>
      </div>
      <span className="ow-canvas-hint">{t("dragToPan")}</span>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Role properties
// ---------------------------------------------------------------------------------------------

function Section({ id, title, icon, open, onToggle, children }: { id: string; title: string; icon: IconName; open: boolean; onToggle: (id: string, open: boolean) => void; children: React.ReactNode }) {
  return (
    <details className="ow-form-section" open={open} onToggle={(e) => onToggle(id, (e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <span className="ow-section-icon">
          <Icon name={icon} size={16} />
        </span>
        <span>{title}</span>
        <Icon name="chevron-down" size={15} />
      </summary>
      <div className="ow-section-body">{children}</div>
    </details>
  );
}

function Panel({
  node,
  nodes,
  editable,
  onChange,
  onAddChild,
  onAddPeer,
  onDelete,
  onClose,
}: {
  node: DraftNode;
  nodes: DraftNode[];
  editable: boolean;
  onChange: (patch: Partial<DraftNode>) => void;
  onAddChild: () => void;
  onAddPeer: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("builder");
  const [open, setOpen] = useState<Record<string, boolean>>({ structure: true, people: true });
  const toggle = (id: string, o: boolean) => setOpen((s) => ({ ...s, [id]: o }));
  const managers = nodes.filter((n) => !descendants(nodes, node.id).has(n.id));
  const parent = nodes.find((n) => n.id === node.parent_id);
  const departments = [...new Set(nodes.map((n) => n.department).filter(Boolean))];
  const filled = !node.vacant && Boolean(node.name);
  const details = (rows: [string, string][]) => (
    <dl className="ow-role-details">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
  return (
    <aside className="ow-editor" id="ow-role-properties" aria-label={t("properties")}>
      <header className="ow-editor-title">
        <span className={`ow-editor-avatar${filled ? "" : " ow-editor-avatar-vacant"}`} aria-hidden="true">
          {filled && node.name ? initials(node.name) : <Icon name="user" size={19} />}
        </span>
        <div className="ow-editor-identity">
          <span className="ow-caption">{t("properties")}</span>
          <h4 title={node.title}>{node.title || t("untitled")}</h4>
          <p>{filled ? node.name : node.department || t("vacant")}</p>
        </div>
        <span className={`ow-holder-tag${filled ? " ow-holder-filled" : ""}`}>
          <span />
          {filled ? t("filled") : t("vacant")}
        </span>
        <button type="button" className="ow-icon-btn ow-close-panel" onClick={onClose} aria-label={t("close")} title={t("close")}>
          <Icon name="x" size={18} />
        </button>
      </header>
      <div className="ow-editor-fields">
        <Section id="structure" title={t("structure")} icon="network" open={open.structure} onToggle={toggle}>
          {editable ? (
            <>
              <label className="ow-field">
                {t("title")}
                <input autoFocus value={node.title} placeholder={t("titlePlaceholder")} maxLength={80} onChange={(e) => onChange({ title: e.target.value })} />
              </label>
              <div className="ow-field-pair">
                <label className="ow-field">
                  {t("department")}
                  <input list="org-departments" value={node.department} maxLength={60} onChange={(e) => onChange({ department: e.target.value })} />
                  <datalist id="org-departments">
                    {departments.map((d) => (
                      <option key={d} value={d} />
                    ))}
                  </datalist>
                </label>
                <label className="ow-field">
                  {t("reportsTo")}
                  <select value={node.parent_id ?? ""} disabled={!node.parent_id && nodes.filter((n) => !n.parent_id).length <= 1} onChange={(e) => onChange({ parent_id: e.target.value || null })}>
                    <option value="">{t("topOfOrg")}</option>
                    {managers.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.title || t("untitled")}
                        {m.name ? ` · ${m.name}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="ow-role-tools">
                <button className="ow-text-button" type="button" onClick={onAddChild}>
                  <Icon name="plus" size={15} /> {t("addReport")}
                </button>
                {node.parent_id && (
                  <button className="ow-text-button" type="button" onClick={onAddPeer}>
                    <Icon name="plus" size={15} /> {t("addPeer")}
                  </button>
                )}
                <button className="ow-text-button ow-delete" type="button" onClick={onDelete}>
                  <Icon name="trash" size={15} /> {t("delete")}
                </button>
              </div>
            </>
          ) : (
            details([
              [t("department"), node.department],
              [t("reportsTo"), parent?.title ?? t("topOfOrg")],
            ])
          )}
        </Section>
        <Section id="people" title={t("people")} icon="users" open={open.people} onToggle={toggle}>
          {editable ? (
            <>
              <label className="ow-field">
                {t("holderStatus")}
                <select
                  value={node.vacant ? "vacant" : "filled"}
                  onChange={(e) => onChange(e.target.value === "vacant" ? { vacant: true, name: "", email: "" } : { vacant: false })}
                >
                  <option value="filled">{t("filled")}</option>
                  <option value="vacant">{t("vacant")}</option>
                </select>
              </label>
              {!node.vacant && (
                <div className="ow-person-fields">
                  <label className="ow-field">
                    {t("person")}
                    <input value={node.name} maxLength={80} autoComplete="off" onChange={(e) => onChange({ name: e.target.value })} />
                  </label>
                  <label className="ow-field">
                    {t("email")}
                    <input type="email" value={node.email} maxLength={120} autoComplete="off" onChange={(e) => onChange({ email: e.target.value })} />
                  </label>
                  <p>{t("emailHint")}</p>
                </div>
              )}
            </>
          ) : (
            details(filled ? [[t("person"), node.name], [t("email"), node.email]] : [[t("holderStatus"), t("vacant")]])
          )}
        </Section>
        {!editable &&
          node.sections?.map((sec) => (
            <Section key={sec.key} id={sec.key} title={sec.title} icon={sec.icon} open={Boolean(open[sec.key])} onToggle={toggle}>
              {sec.list ? (
                sec.list.length ? (
                  <ul className="ow-metric-list">
                    {sec.list.map((m) => (
                      <li key={m}>
                        <Icon name="activity" size={15} />
                        {m}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>—</p>
                )
              ) : (
                details(sec.rows ?? [])
              )}
            </Section>
          ))}
      </div>
      <div className="ow-editor-actions ow-editor-readonly">
        <Icon name={editable ? "check" : "eye"} size={16} /> {editable ? t("autosaves") : t("readOnlyProps")}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------------------------
// Ways to start (the design's source panel)
// ---------------------------------------------------------------------------------------------

function SourceTile({ icon, title, hint, busy, disabled, onClick }: { icon: IconName; title: string; hint: string; busy: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button type="button" className="ow-source" disabled={disabled} onClick={onClick}>
      <span className="ow-source-icon">
        <Icon name={busy ? "refresh" : icon} size={21} />
      </span>
      <strong>{title}</strong>
      <span>{hint}</span>
      <Icon name="arrow-right" size={17} />
    </button>
  );
}

/** A small drawing of a sample layout: one box per role, joined to its parent. */
function TemplatePreview({ shape }: { shape: (number | null)[] }) {
  const depth = shape.map((_, i) => {
    let d = 0;
    for (let p = shape[i]; p !== null && p !== undefined; p = shape[p]) d += 1;
    return d;
  });
  const rows = Math.max(...depth) + 1;
  const width = 256;
  const height = 112;
  const boxW = 34;
  const boxH = 14;
  const x: number[] = [];
  const perRow = new Map<number, number[]>();
  depth.forEach((d, i) => perRow.set(d, [...(perRow.get(d) ?? []), i]));
  perRow.forEach((ids) => ids.forEach((id, k) => (x[id] = ((k + 1) * width) / (ids.length + 1))));
  const y = (d: number) => (rows === 1 ? height / 2 : 22 + (d * (height - 52)) / (rows - 1));
  return (
    <span className="ow-template-preview" aria-hidden="true">
      <svg viewBox={`0 0 ${width} ${height}`}>
        {shape.map((parent, i) =>
          parent === null ? null : (
            <path key={`l${i}`} d={`M${x[parent]} ${y(depth[parent]) + boxH / 2}V${(y(depth[parent]) + y(depth[i])) / 2}H${x[i]}V${y(depth[i]) - boxH / 2}`} />
          ),
        )}
        {shape.map((parent, i) => (
          <rect key={`b${i}`} x={x[i] - boxW / 2} y={y(depth[i]) - boxH / 2} width={boxW} height={boxH} rx={4} className={parent === null ? "ow-template-root" : undefined} />
        ))}
      </svg>
    </span>
  );
}

function Sources({
  templates,
  hasNodes,
  onDraft,
  onBlank,
}: {
  templates: OrgTemplate[];
  hasNodes: boolean;
  onDraft: (d: OrgDraft) => void;
  onBlank: () => void;
}) {
  const t = useTranslations("builder");
  const file = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const confirmReplace = () => !hasNodes || window.confirm(t("replaceConfirm"));

  function run(kind: string, fn: () => Promise<Result<OrgDraft>>) {
    if (!confirmReplace()) return;
    setBusy(kind);
    start(async () => {
      const res = await fn();
      setBusy(null);
      if (res.ok && res.data) {
        onDraft(res.data);
        setError(null);
        setShowTemplates(false);
      } else setError(res.ok ? t("failed") : res.error);
    });
  }

  function upload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const isImage = /\.(png|jpe?g|webp|heic)$/i.test(f.name);
    const form = new FormData();
    form.set("file", f);
    run(isImage ? "photo" : "file", () => importOrgFile(form));
  }

  function microsoft() {
    if (!confirmReplace()) return;
    setBusy("microsoft");
    start(async () => {
      const res = await microsoftConsentUrl();
      if (res.ok && res.data) window.location.href = res.data.url;
      else {
        setBusy(null);
        setError(res.ok ? t("failed") : res.error);
      }
    });
  }

  return (
    <>
      <input ref={file} type="file" accept={ACCEPT} className="hidden" onChange={upload} />
      {showTemplates ? (
        <>
          <div className="ow-source-heading ow-source-subheading">
            <div>
              <h4>{t("sampleTitle")}</h4>
              <p>{t("sampleBody")}</p>
            </div>
            <button type="button" className="ow-text-button" onClick={() => setShowTemplates(false)}>
              {t("allOptions")}
            </button>
          </div>
          <div className="ow-source-grid">
            {templates.map((tp) => (
              <button key={tp.key} type="button" className="ow-source ow-template" disabled={pending} onClick={() => run("template", () => importOrgTemplate(tp.key))}>
                <TemplatePreview shape={tp.shape} />
                <strong>{tp.name}</strong>
                <Icon name="arrow-right" size={17} />
                <span>
                  <span className="ow-template-count">{t("roles", { n: tp.roles })}</span>
                  {tp.about}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="ow-source-grid">
            <SourceTile icon="upload" title={t("src.file")} hint={t("src.fileHint")} busy={busy === "file" || busy === "photo"} disabled={pending} onClick={() => file.current?.click()} />
            <SourceTile icon="network" title={t("src.manual")} hint={t("src.manualHint")} busy={false} disabled={pending} onClick={onBlank} />
            <a href="/onboarding/template" download className="ow-source">
              <span className="ow-source-icon">
                <Icon name="table" size={21} />
              </span>
              <strong>{t("src.csv")}</strong>
              <span>{t("src.csvHint")}</span>
              <Icon name="arrow-right" size={17} />
            </a>
          </div>
          <details className="ow-more-sources">
            <summary>
              {t("moreWays")} <Icon name="chevron-down" size={16} />
            </summary>
            <div className="ow-source-grid">
              <SourceTile icon="users" title={t("src.microsoft")} hint={t("src.microsoftHint")} busy={busy === "microsoft"} disabled={pending} onClick={microsoft} />
              <SourceTile icon="layers" title={t("src.template")} hint={t("src.templateHint")} busy={busy === "template"} disabled={pending} onClick={() => setShowTemplates(true)} />
            </div>
          </details>
        </>
      )}
      <p>
        {busy === "photo" && <span>{t("readingPhoto")}</span>}
        {error && <span className="ow-source-error"> {error}</span>}
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------------------------

const SOURCE_LABEL: Record<string, string> = {
  blank: "Manual draft",
  template: "Template draft",
  file: "File import",
  photo: "Sketch import",
  microsoft: "Microsoft 365",
};

export function OrgBuilder({
  draft,
  editable,
  templates = [],
  footer,
}: {
  draft: OrgDraft;
  editable: boolean;
  templates?: OrgTemplate[];
  /** Replaces the footer note (the live Org Web explains cards flow here). */
  footer?: string;
}) {
  const t = useTranslations("builder");
  const [nodes, setNodes] = useState<DraftNode[]>(draft.nodes);
  const [past, setPast] = useState<DraftNode[][]>([]);
  const [future, setFuture] = useState<DraftNode[][]>([]);
  const [selected, setSelected] = useState<string | null>(draft.nodes[0]?.id ?? null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [mode, setMode] = useState<"tree" | "list">("tree");
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [check, setCheck] = useState(draft.check);
  const [save, setSave] = useState<"saved" | "saving" | "error">("saved");
  const [saveError, setSaveError] = useState<string | null>(null);
  const dirty = useRef(false);

  // A new draft from the server (import, submit, withdraw) replaces local state.
  const stamp = `${draft.updated_at}|${draft.status}|${draft.source}`;
  const [seen, setSeen] = useState(stamp);
  if (seen !== stamp) {
    setSeen(stamp);
    setNodes(draft.nodes);
    setCheck(draft.check);
    setPast([]);
    setFuture([]);
    setSelected(draft.nodes[0]?.id ?? null);
    setReplacing(false);
  }

  const commit = useCallback((next: DraftNode[]) => {
    setNodes((cur) => {
      setPast((p) => [...p.slice(-49), cur]);
      return next;
    });
    setFuture([]);
    dirty.current = true;
  }, []);

  // Autosave, debounced.
  useEffect(() => {
    if (!editable || !dirty.current) return;
    setSave("saving");
    const timer = setTimeout(async () => {
      const res = await saveOrgDraft(nodes);
      dirty.current = false;
      if (res.ok && res.data) {
        setCheck(res.data.check);
        setSave("saved");
        setSaveError(null);
      } else {
        setSave("error");
        setSaveError(res.ok ? null : res.error);
      }
    }, 700);
    return () => clearTimeout(timer);
  }, [nodes, editable]);

  const undo = useCallback(() => {
    setPast((p) => {
      if (!p.length) return p;
      setFuture((f) => [nodes, ...f]);
      setNodes(p[p.length - 1]);
      dirty.current = true;
      return p.slice(0, -1);
    });
  }, [nodes]);
  const redo = useCallback(() => {
    setFuture((f) => {
      if (!f.length) return f;
      setPast((p) => [...p, nodes]);
      setNodes(f[0]);
      dirty.current = true;
      return f.slice(1);
    });
  }, [nodes]);

  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !typing) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, undo, redo]);

  const add = (parent: string | null) => {
    const n: DraftNode = { id: newId(), title: "", parent_id: parent, name: "", email: "", department: "", vacant: true };
    const dept = nodes.find((x) => x.id === parent)?.department;
    if (dept) n.department = dept;
    commit([...nodes, n]);
    setSelected(n.id);
    setPanelOpen(true);
  };
  const patch = (id: string, p: Partial<DraftNode>) => {
    commit(nodes.map((n) => (n.id === id ? { ...n, ...p, vacant: p.vacant ?? (p.name !== undefined ? !p.name.trim() : n.vacant) } : n)));
  };
  const remove = (id: string) => {
    const gone = nodes.find((n) => n.id === id);
    commit(nodes.filter((n) => n.id !== id).map((n) => (n.parent_id === id ? { ...n, parent_id: gone?.parent_id ?? null } : n)));
    setSelected(null);
  };

  const sel = nodes.find((n) => n.id === selected) ?? nodes[0] ?? null;
  const companyRoot = nodes.find((n) => !n.parent_id) ?? nodes[0];
  const start = (focus && sel && nodes.find((n) => n.id === sel.id)) || companyRoot;
  const people = nodes.filter((n) => !n.vacant && n.name).length;
  const departments = new Set(nodes.map((n) => n.department).filter(Boolean)).size;
  const q = query.trim().toLowerCase();
  const matches = nodes.filter((n) => [n.title, n.name, n.department, n.email].some((v) => (v || "").toLowerCase().includes(q)));

  const heading = (
    <header className="ow-builder-title">
      <div>
        <span className="ow-caption">{t("caption")}</span>
        <h3>{t("structureTitle")}</h3>
        <p>
          {nodes.length} {nodes.length === 1 ? t("role1") : t("roles2")} · {departments} {departments === 1 ? t("dept1") : t("depts2")} · {nodes.length - people} {t("vacantWord")}
        </p>
      </div>
      <div className="ow-header-actions">
        <span className="tag ow-source-tag">
          {!editable ? (
            <>
              <Icon name="eye" size={14} /> {t("readOnly")}
            </>
          ) : (
            SOURCE_LABEL[draft.source] ?? t("draftWord")
          )}
        </span>
        {editable && (
          <>
            <button type="button" className="ow-text-button" onClick={undo} disabled={!past.length} title="Ctrl+Z">
              {t("undo")}
            </button>
            <button type="button" className="ow-text-button" onClick={redo} disabled={!future.length} title="Ctrl+Shift+Z">
              {t("redo")}
            </button>
            <button type="button" className="ow-text-button" onClick={() => add(null)}>
              {t("addTop")}
            </button>
            <button type="button" className="ow-text-button" onClick={() => setReplacing(true)}>
              {t("startNew")}
            </button>
          </>
        )}
      </div>
    </header>
  );

  if (!nodes.length && !editable) {
    return (
      <section className="ow-card ow-waiting" aria-labelledby="ow-waiting-title">
        <div className="ow-waiting-main">
          <div className="ow-waiting-copy">
            <span className="tag tag-attention">
              <Icon name="clock" size={14} /> {t("waitingTag")}
            </span>
            <h3 id="ow-waiting-title">{t("waitingTitle")}</h3>
            <p>{t("waitingBody")}</p>
          </div>
          <div className="ow-waiting-graphic" aria-hidden="true">
            <svg viewBox="0 0 320 146" focusable="false">
              <path className="ow-waiting-edge" d="M160 62 C160 84 75 67 75 94 M160 62 C160 84 245 67 245 94" />
              <rect className="ow-waiting-root" x="104" y="17" width="112" height="45" rx="11" />
              <rect className="ow-waiting-node" x="24" y="94" width="102" height="36" rx="9" />
              <rect className="ow-waiting-node ow-waiting-draft" x="194" y="94" width="102" height="36" rx="9" />
              <circle className="ow-waiting-avatar" cx="123" cy="39.5" r="7.5" />
              <circle className="ow-waiting-avatar" cx="42" cy="112" r="6" />
              <circle className="ow-waiting-avatar" cx="212" cy="112" r="6" />
              <path className="ow-waiting-detail" d="M138 36h52 M138 44h32 M55 112h51 M225 112h51" />
            </svg>
          </div>
        </div>
        <ol className="ow-waiting-steps" aria-label={t("handoff")}>
          <li aria-current="step">
            <span className="ow-waiting-step-icon">
              <Icon name="network" size={17} />
            </span>
            <div>
              <strong>{t("stepCustomer")}</strong>
              <small>{t("stepCustomerNote")}</small>
            </div>
          </li>
          <li>
            <span className="ow-waiting-step-icon">
              <Icon name="eye" size={17} />
            </span>
            <div>
              <strong>{t("stepFormada")}</strong>
              <small>{t("stepFormadaNote")}</small>
            </div>
          </li>
        </ol>
      </section>
    );
  }

  if ((!nodes.length || replacing) && editable) {
    return (
      <section className="ow-card ow-source-panel">
        <div className="ow-source-heading">
          <div>
            <span className="ow-caption">{t("sourceCaption")}</span>
            <h3>{nodes.length ? t("replaceTitle") : t("startTitle")}</h3>
          </div>
          {nodes.length > 0 && (
            <button className="btn btn-secondary" type="button" onClick={() => setReplacing(false)}>
              <Icon name="arrow-left" size={16} /> {t("backToBuilder")}
            </button>
          )}
        </div>
        <p>{t("startBody")}</p>
        <Sources
          templates={templates}
          hasNodes={nodes.length > 0}
          onBlank={() => {
            setReplacing(false);
            if (!nodes.length) add(null);
          }}
          onDraft={(d) => {
            setNodes(d.nodes);
            setCheck(d.check);
            setPast([]);
            setSelected(d.nodes[0]?.id ?? null);
            setReplacing(false);
          }}
        />
      </section>
    );
  }

  const footerNote = footer ?? (editable ? t("footerEdit") : t("footerRead"));
  return (
    <section className="ow-card ow-builder">
      {heading}
      <div className="ow-toolbar">
        <div className="ow-segment" aria-label={t("display")}>
          <button type="button" aria-pressed={mode === "tree"} onClick={() => setMode("tree")}>
            <Icon name="network" size={16} /> {t("tree")}
          </button>
          <button type="button" aria-pressed={mode === "list"} onClick={() => setMode("list")}>
            <Icon name="list" size={16} /> {t("list")}
          </button>
        </div>
        <button className="ow-text-button ow-branch" type="button" onClick={() => setFocus((f) => !f)}>
          {focus ? t("showCompany") : t("focusBranch")}
        </button>
        {!panelOpen && (
          <button className="ow-text-button ow-reopen-panel" type="button" aria-expanded="false" onClick={() => setPanelOpen(true)}>
            <Icon name="panel-right" size={16} /> {t("properties")}
          </button>
        )}
        <label className="ow-search">
          <Icon name="search" size={16} />
          <input type="search" placeholder={t("find")} aria-label={t("find")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      <div className={`ow-builder-body${panelOpen ? "" : " ow-panel-closed"}`}>
        <div className="ow-graph">
          {mode === "tree" && q && (
            <div className="ow-search-results">
              <Rows nodes={matches} selected={sel?.id ?? null} onSelect={(id) => { setSelected(id); setPanelOpen(true); setFocus(false); setQuery(""); }} empty={t("noMatch")} />
            </div>
          )}
          {mode === "tree" ? (
            <Graph
              key={`${start.id}-${nodes.length}`}
              nodes={nodes}
              root={start}
              selected={sel?.id ?? null}
              editable={editable}
              onSelect={(id) => {
                setSelected(id);
                setPanelOpen(true);
              }}
              onAdd={add}
            />
          ) : (
            <div className="ow-role-list">
              <Rows nodes={matches} selected={sel?.id ?? null} onSelect={(id) => { setSelected(id); setPanelOpen(true); }} empty={t("noMatch")} />
            </div>
          )}
        </div>
        {panelOpen && sel && (
          <Panel
            key={sel.id}
            node={sel}
            nodes={nodes}
            editable={editable}
            onChange={(p) => patch(sel.id, p)}
            onAddChild={() => add(sel.id)}
            onAddPeer={() => add(sel.parent_id)}
            onDelete={() => remove(sel.id)}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </div>
      {editable && (check.errors.length > 0 || save === "error") && (
        <ul className="ow-rules">
          {check.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
          {save === "error" && <li>{saveError ?? t("saveFailed")}</li>}
        </ul>
      )}
      <footer className="ow-footer">
        <p>
          {footerNote}
          {editable && ` · ${save === "saving" ? t("saving") : save === "error" ? t("saveFailed") : t("saved")}`}
        </p>
      </footer>
    </section>
  );
}

function Rows({ nodes, selected, onSelect, empty }: { nodes: DraftNode[]; selected: string | null; onSelect: (id: string) => void; empty: string }) {
  const t = useTranslations("builder");
  if (!nodes.length) return <div className="ow-list-empty">{empty}</div>;
  return (
    <>
      {nodes.map((n) => (
        <button key={n.id} type="button" className={`ow-list-row${selected === n.id ? " ow-list-selected" : ""}`} aria-pressed={selected === n.id} onClick={() => onSelect(n.id)}>
          <span>
            <strong>{n.title || t("untitled")}</strong>
            <small>{n.department || t("leadership")}</small>
          </span>
          <span>{n.vacant || !n.name ? t("vacant") : n.name}</span>
          <Icon name="arrow-right" size={15} />
        </button>
      ))}
    </>
  );
}
