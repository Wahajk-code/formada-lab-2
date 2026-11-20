import type { ThreadStep } from "@/lib/client-api";
import type { TeamStep } from "@/lib/console-api";

/** The Formada view's steps (design + ADR 0030): name, title, purpose, icon and owner. */
export const STEP_META: Record<
  ThreadStep,
  { name: string; title: string; what: string; icon: string; owner: string }
> = {
  connect: {
    name: "Snowflake",
    title: "Snowflake connection",
    what: "Set up a secure, read-only connection to the customer's Snowflake warehouse.",
    icon: "snowflake",
    owner: "Formada",
  },
  discovery: {
    name: "Discovery",
    title: "Data discovery",
    what: "See which schemas, tables and fields were found in the warehouse.",
    icon: "database",
    owner: "Formada",
  },
  mapping: {
    name: "Mapping",
    title: "Data mapping",
    what: "Review how discovered tables and fields map to the Formada standard model.",
    icon: "layers",
    owner: "Formada",
  },
  org: {
    name: "Org Web",
    title: "Org Web",
    what: "The customer builds or imports the reporting structure that gives every insight an owner.",
    icon: "network",
    owner: "Workspace admin",
  },
  metrics: {
    name: "Metrics",
    title: "Role metrics",
    what: "Generate, review and publish the measures and business rules for each role.",
    icon: "chart",
    owner: "Formada",
  },
  rules: {
    name: "Rules",
    title: "Business rules",
    what: "Set inside Role metrics.",
    icon: "shield",
    owner: "Formada",
  },
  trial: {
    name: "Trial run",
    title: "Trial run",
    what: "Run the setup on real data, check coverage, and let the customer go live.",
    icon: "play",
    owner: "Workspace admin",
  },
};

/** The six steps in order (rules live inside metrics). */
export const TEAM_STEP_ORDER: ThreadStep[] = ["connect", "discovery", "mapping", "org", "metrics", "trial"];

export const STATUS_LABEL: Record<TeamStep["status"], string> = {
  done: "Complete",
  client_review: "Waiting on customer",
  working: "AI working…",
  waiting: "Waiting on customer",
  review: "Needs your review",
  failed: "Failed",
  locked: "Locked",
  todo: "In progress",
};
