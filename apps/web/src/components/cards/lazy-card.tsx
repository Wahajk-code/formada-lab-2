"use client";

import { useEffect, useState } from "react";

import { getCard } from "@/app/actions";
import { InsightCard } from "@/components/cards/insight-card";
import type { Card } from "@/lib/client-api";

/** The original insight, fetched when its row is opened (history and initiative details). It is
 * shown read-only: the decision was already made. */
export function LazyCard({ id, roleTitle, department }: { id: string; roleTitle: string; department?: string | null }) {
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getCard(id).then((res) => {
      if (!live) return;
      if (res.ok && res.data) setCard(res.data);
      else setError(res.ok ? "?" : res.error);
    });
    return () => {
      live = false;
    };
  }, [id]);
  if (error) return <p className="dw-quiet">{error}</p>;
  if (!card) return <p className="dw-quiet">…</p>;
  return <InsightCard card={card} roleTitle={roleTitle} department={department} canAct={false} />;
}
