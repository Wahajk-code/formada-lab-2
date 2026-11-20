import { ViewTransition } from "react";

/** Wraps one onboarding step's body so it slides with the direction of travel. Goes in each
 * page (not the layout), so enter and exit fire on navigation. Refreshes and polling carry no
 * transition type, so they do not animate. */
export function StepTransition({ children }: { children: React.ReactNode }) {
  const slide = {
    "step-forward": "step-forward",
    "step-back": "step-back",
    default: "none",
  };
  return (
    <ViewTransition enter={slide} exit={slide} default="none">
      <div>{children}</div>
    </ViewTransition>
  );
}
