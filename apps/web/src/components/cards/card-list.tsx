import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import type { Card } from "@/lib/client-api";
import { money } from "@/lib/format";
import { cn } from "@/lib/utils";

export async function CardList({
  cards,
  selectedId,
  hrefFor,
  labelFor,
}: {
  cards: Card[];
  selectedId?: string;
  hrefFor: (card: Card) => string;
  labelFor?: (card: Card) => string | null;
}) {
  const [t, locale] = await Promise.all([getTranslations("cards"), getLocale()]);
  return (
    <ol className="space-y-2">
      {cards.map((card, i) => {
        const selected = card.id === selectedId;
        const label = labelFor?.(card);
        const kind = card.evidence.signal_kind;
        return (
          <li key={card.id} className="animate-rise" style={{ animationDelay: `${i * 50}ms` }}>
            <Link
              href={hrefFor(card)}
              scroll={false}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "group block rounded-xl px-4 py-3 transition-all duration-200",
                selected
                  ? "bg-card shadow-card-hover ring-1 ring-foreground/10"
                  : "bg-surface hover:-translate-y-px hover:bg-card hover:shadow-card",
              )}
            >
              <div className="flex items-start gap-3">
                <span
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums",
                    selected ? "bg-foreground text-background" : "bg-surface-strong text-muted-foreground",
                  )}
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-medium leading-snug">{card.title}</p>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span className="font-medium tabular-nums text-foreground">
                      {money(card.expected_impact, card.impact_unit, locale, true)}
                    </span>
                    {kind && <span>· {t(`kind.${kind}`)}</span>}
                    {label && <span className="rounded-full bg-surface-strong px-2 py-0.5">{label}</span>}
                  </p>
                </div>
              </div>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
