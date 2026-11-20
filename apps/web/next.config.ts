import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Docker Desktop on Windows drops file events across the bind mount; the dev
// container opts into polling via NEXT_WATCH_POLL_MS. Unset on the host.
const pollIntervalMs = process.env.NEXT_WATCH_POLL_MS
  ? Number(process.env.NEXT_WATCH_POLL_MS)
  : undefined;

const nextConfig: NextConfig = {
  // The dev server only trusts `localhost`; without this, opening http://127.0.0.1:3100 renders
  // the page but blocks its scripts, so nothing is clickable.
  allowedDevOrigins: ["127.0.0.1"],
  // Org chart uploads (photo, Excel, Visio, PowerPoint) go through a server action; the API caps
  // the file at 5 MB.
  experimental: { serverActions: { bodySizeLimit: "6mb" } },
  ...(pollIntervalMs ? { watchOptions: { pollIntervalMs } } : {}),
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default withNextIntl(nextConfig);
