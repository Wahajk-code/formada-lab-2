import { notFound, redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { ClientQuestions } from "@/components/onboarding/client-questions";
import { ClientTrial } from "@/components/onboarding/client-trial";
import { DraftActions } from "@/components/onboarding/draft-actions";
import { OrgBuilder } from "@/components/onboarding/org-builder";
import {
  CheckinCard,
  ConnectStory,
  LockedCard,
  MetricsStatus,
  PrepareStory,
  SetupStepper,
} from "@/components/onboarding/setup";
import { GoLiveButton, MetricSuggestion } from "@/components/onboarding/setup-actions";
import { api, CLIENT_STEPS, type ClientStepKey } from "@/lib/client-api";

/** One client onboarding step in the Formada.AI design: heading, stepper, the stage view and a
 * rail with Questions and the next check-in (ADR 0030). */
export default async function StepPage({
  params,
  searchParams,
}: {
  params: Promise<{ step: string }>;
  searchParams: Promise<{ thread?: string }>;
}) {
  const [{ step }, { thread }] = await Promise.all([params, searchParams]);
  if (!CLIENT_STEPS.includes(step as ClientStepKey)) notFound();
  const key = step as ClientStepKey;
  const [ob, me, t, locale] = await Promise.all([api.onboarding(), api.me(), getTranslations("setup"), getLocale()]);
  if (ob.member) return null;
  const info = ob.steps.find((s) => s.key === key)!;
  if (!info.can_open && key !== ob.current) redirect(`/onboarding/${ob.current}`);

  const admin = me.app_role === "owner" || me.app_role === "admin";
  const live = ob.lifecycle === "live";
  const index = CLIENT_STEPS.indexOf(key);
  const names = Object.fromEntries(CLIENT_STEPS.map((k) => [k, t(`names.${k}`)]));
  const statuses = Object.fromEntries(
    (["done", "upcoming", "your_input", "waiting_on_you", "with_formada"] as const).map((s) => [s, t(`status.${s}`)]),
  );
  const covers = info.steps;
  const threads = ob.threads.filter((x) => covers.includes(x.step));
  const askStep = covers.includes(ob.team_current) ? ob.team_current : covers[covers.length - 1];
  const sub = (ns: string) => (k: string) => t(`${ns}.${k}`);

  let content: React.ReactNode;
  if (!info.can_open) {
    const prev = CLIENT_STEPS[Math.max(0, index - 1)];
    content = (
      <LockedCard
        eyebrow={t("locked.eyebrow")}
        title={t("locked.title", { step: t(`titles.${key}`) })}
        body={t("locked.body", { prev: t(`titles.${prev}`) })}
        back={t("locked.back")}
        href={`/onboarding/${ob.current}`}
      />
    );
  } else if (key === "connect") {
    content = <ConnectStory verified={info.status === "done"} t={sub("connect")} />;
  } else if (key === "prepare") {
    content = (
      <PrepareStory
        state={info.status === "done" ? "done" : info.status === "waiting_on_you" ? "waiting" : "working"}
        t={sub("prepare")}
      />
    );
  } else if (key === "org") {
    const draft = ob.draft;
    content = draft ? (
      <div className="space-y-4">
        <OrgBuilder
          draft={draft}
          editable={admin && ob.can_edit_draft && draft.status === "draft"}
          templates={info.status === "your_input" ? (await api.draftTemplates()).templates : []}
        />
        {admin && ob.can_edit_draft && <DraftActions draft={draft} />}
      </div>
    ) : null;
  } else if (key === "metrics") {
    const ready = info.status === "done";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- summary JSON from the API
    const measures: any[] = (ob.signoffs.metrics?.summary?.measures as any[]) ?? [];
    const roles = new Map<string, string[]>();
    for (const m of measures) for (const f of m.for ?? []) roles.set(f.role, [...(roles.get(f.role) ?? []), m.name]);
    const suggestionTitle = t("metrics.threadTitle");
    const sent = ob.threads
      .filter((x) => x.step === "metrics" && x.raised_by === "client" && x.title === suggestionTitle)
      .map((x) => ({ text: x.messages[0]?.body ?? "", at: x.messages[0]?.at ?? x.updated_at }));
    content = (
      <>
        <MetricsStatus
          ready={ready}
          t={sub("metrics")}
          byRole={ready ? [...roles.entries()].map(([role, list]) => ({ role, measures: list })) : []}
        />
        <MetricSuggestion sent={sent} can={admin && !ready && !live} />
      </>
    );
  } else {
    const trial = await api.onboardingTrial().catch(() => null);
    content = (
      <>
        {trial?.run ? <ClientTrial trial={trial} /> : <section className="stage-panel"><div className="stage-empty"><h3>{t("live.title")}</h3><p>{t("live.waiting")}</p></div></section>}
        <div className="stage-complete">
          <div>
            <span>{live ? t("live.liveBody") : t("live.goLiveNote")}</span>
          </div>
          {admin && <GoLiveButton ready={ob.go_live.ready} live={live} />}
        </div>
      </>
    );
  }

  return (
    <>
      <div className="onboarding-heading">
        <div>
          <h1>{t("heading")}</h1>
          <p>{t("subheading")}</p>
        </div>
      </div>
      <SetupStepper steps={ob.steps} current={key} names={names} statuses={statuses} />
      <section className="step-content" aria-labelledby="step-heading">
        <header className="step-heading">
          <div>
            <h2 id="step-heading">{t(`titles.${key}`)}</h2>
            <p>{t(`descriptions.${key}`)}</p>
          </div>
        </header>
        <div className={`onboarding-grid ${key === "org" && info.can_open ? "builder-layout" : ""}`}>
          <div id="stage-view">
            <div className="stage-stack">{content}</div>
          </div>
          <aside className="onboard-rail" aria-label="Setup support">
            <div id="question-slot">
              <ClientQuestions step={askStep} threads={threads} can={admin && !live} initialThread={thread ?? null} />
            </div>
            {ob.checkin && <CheckinCard checkin={ob.checkin} locale={locale} t={sub("checkin")} />}
          </aside>
        </div>
      </section>
    </>
  );
}
