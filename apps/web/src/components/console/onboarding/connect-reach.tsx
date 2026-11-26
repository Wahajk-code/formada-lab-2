import { fmt, humanName, Section, Status } from "@/components/console/onboarding/review-kit";
import type { OnboardingGuide } from "@/lib/console-api";

/**
 * What the connection can actually read, right after it passes the test. All data reaches us
 * through the customer's semantic views (ADR 0033), so the first thing to know is whether any view
 * is readable, and how big each one is. Shown once a scan has seen them.
 */
export function ConnectReach({ guide }: { guide: OnboardingGuide | null }) {
  if (!guide) return null;
  const views = guide.semantic_views ?? [];
  return (
    <Section
      id="rv-reach"
      icon="layers"
      title="What this connection can read"
      point="All data reaches us through the customer's semantic views, so this is what everything after it is built from."
      count={views.length ? <Status tone="ready">{fmt.plural(views.length, "view")} readable</Status> : <Status tone="fail">No view found</Status>}
    >
      {views.length === 0 ? (
        <p className="stage-helper">
          No semantic view is readable with this role. Ask the customer&apos;s Snowflake administrator to grant read access to the schema that holds their semantic views, then test again.
        </p>
      ) : (
        <div className="stage-table-scroll">
          <table className="stage-table rv-compact">
            <thead>
              <tr>
                <th scope="col">View</th>
                <th scope="col">Tables</th>
                <th scope="col">Fields</th>
                <th scope="col">Measures</th>
                <th scope="col">Links</th>
              </tr>
            </thead>
            <tbody>
              {views.map((v) => (
                <tr key={v.view}>
                  <td>
                    <b>{humanName(v.view)}</b>
                    <small className="rv-muted"> {v.view}</small>
                  </td>
                  <td>{v.tables.length}</td>
                  <td>{v.tables.reduce((n, t) => n + t.dimensions.length, 0)}</td>
                  <td>{v.tables.reduce((n, t) => n + t.metrics.length, 0)}</td>
                  <td>{v.relationships.length || <Status tone="partial">none declared</Status>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
