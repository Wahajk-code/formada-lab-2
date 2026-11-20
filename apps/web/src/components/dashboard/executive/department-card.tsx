"use client";

import { ChevronDown } from "lucide-react";
import { useId, useState } from "react";

import type { UnitLabels } from "@/components/dashboard/executive/format";
import { ReadingTile, type TileLabels } from "@/components/dashboard/executive/reading-tile";
import type { Department } from "@/mocks/executive-overview";

/** One department: its lead reading, with the rest folded away until asked for. */
export function DepartmentCard({
  department: d,
  locale,
  units,
  labels,
  current,
  heading,
  flagged,
  more,
  fewer,
}: {
  department: Department;
  locale: string;
  units: UnitLabels;
  labels: TileLabels;
  current: boolean;
  heading: string;
  flagged: string | null;
  more: string;
  fewer: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const [first, ...rest] = d.readings;
  return (
    <section className="ex-dept">
      <header>
        <div>
          <h3>{d.name}</h3>
          <p>{heading}</p>
        </div>
        {flagged && <span className="ex-flag">{flagged}</span>}
      </header>
      <ReadingTile reading={first} locale={locale} units={units} labels={labels} showRole={current} showNext={current} />
      {rest.length > 0 && (
        <>
          <button type="button" className="ex-more" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
            <span>{open ? fewer : more}</span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
          <div id={id} className="ex-fold" data-open={open}>
            <div className="ex-fold-inner">
              {rest.map((r, i) => (
                <div key={`${r.key}-${r.role}-${i}`} className="ex-extra">
                  <ReadingTile reading={r} locale={locale} units={units} labels={labels} showRole showNext />
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
