import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

// Docker Desktop on Windows drops file events across the bind mount; the dev
// container opts into polling via NEXT_WATCH_POLL_MS. Unset on the host.
const pollIntervalMs = process.env.NEXT_WATCH_POLL_MS
  ? Number(process.env.NEXT_WATCH_POLL_MS)
  : undefined;

// Standard browser protections for every response. The CSP applies in production only (the dev server
// needs eval for hot reload). Scripts and styles keep 'unsafe-inline' because Next injects inline code;
// everything else is locked to this origin, and the app cannot be framed.
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(process.env.NODE_ENV === "production"
    ? [
        {
          key: "Content-Security-Policy",
          value: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            "connect-src 'self'",
            "frame-ancestors 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "object-src 'none'",
          ].join("; "),
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
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
