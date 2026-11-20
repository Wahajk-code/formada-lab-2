"use client";

import { LoaderCircle, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { createWorkspace } from "@/app/console-actions";
import { Button } from "@/components/ui/button";

const FIELD =
  "w-full rounded-lg bg-surface px-3 py-2 text-sm shadow-inner outline-none focus:ring-2 focus:ring-ring/40";

const MODELS = [
  {
    value: "anthropic/claude-haiku-5-5",
    label: "Claude Haiku 5.5 (card writing, lowest cost)",
  },
  { value: "anthropic/claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { value: "anthropic/claude-opus-5-5", label: "Claude Opus 5.5" },
  { value: "fake/fake-cards-v1", label: "Built-in test writer (no tokens)" },
];

export function NewWorkspaceForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function submit(form: FormData) {
    const [provider, model] = String(form.get("llm")).split("/");
    const body = {
      name: form.get("name"),
      owner_name: form.get("owner_name"),
      owner_email: form.get("owner_email"),
      locale: form.get("locale"),
      timezone: form.get("timezone"),
      currency: form.get("currency"),
      llm_provider: provider,
      llm_model: model,
    };
    start(async () => {
      const res = await createWorkspace(body);
      if (res.ok && res.data)
        router.push(`/console/workspaces/${res.data.id}/onboarding`);
      else setError(res.ok ? "Something went wrong" : res.error);
    });
  }

  return (
    <form
      action={submit}
      className="grid max-w-2xl gap-4 rounded-2xl bg-card p-6 shadow-card sm:grid-cols-2"
    >
      <label className="space-y-1 sm:col-span-2">
        <span className="text-xs font-medium text-muted-foreground">
          Company
        </span>
        <input
          name="name"
          required
          minLength={2}
          placeholder="Acme Outfitters"
          className={FIELD}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">
          Owner name
        </span>
        <input name="owner_name" required minLength={2} className={FIELD} />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">
          Owner email
        </span>
        <input name="owner_email" type="email" required className={FIELD} />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">
          Language
        </span>
        <select name="locale" defaultValue="en" className={FIELD}>
          <option value="en">English</option>
          <option value="fr">Français</option>
        </select>
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">
          Currency
        </span>
        <input
          name="currency"
          defaultValue="CAD"
          maxLength={3}
          className={FIELD}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">
          Time zone
        </span>
        <input
          name="timezone"
          defaultValue="America/Toronto"
          className={FIELD}
        />
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium text-muted-foreground">
          Card writer model
        </span>
        <select name="llm" defaultValue={MODELS[0].value} className={FIELD}>
          {MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-muted-foreground sm:col-span-2">
        The onboarding agents (discovery, mapping, org, metrics, rules) use
        their own model, set per agent on the AI agents page.
      </p>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          {pending ? <LoaderCircle className="animate-spin" /> : <Plus />}{" "}
          Create and start onboarding
        </Button>
        {error && <span className="text-sm text-brand">{error}</span>}
      </div>
    </form>
  );
}
