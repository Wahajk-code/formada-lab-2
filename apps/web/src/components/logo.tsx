/* eslint-disable @next/next/no-img-element -- a static SVG mark needs no image optimisation */

/** The Formada.AI mark and wordmark (from the brand files in public/brand). */
export function Logo({
  withName = true,
  size = 34,
  reversed = false,
}: {
  withName?: boolean;
  size?: number;
  reversed?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <img
        src={reversed ? "/brand/formada-mark-reversed.svg" : "/brand/formada-mark.svg"}
        alt=""
        width={size}
        height={size}
        className="object-contain"
      />
      {withName && (
        <span className="text-[25px] leading-none font-extrabold tracking-[-0.065em]">
          Formada<span className="font-semibold">.AI</span>
        </span>
      )}
    </span>
  );
}
