import { ActorBadge, LoginPage, SitePicker, Shell, useAuth, useLocalState, useRefs } from "@corelogistics/ui";
import { useCallback } from "react";
import { AnalyticsView } from "./AnalyticsView";
import { DesignerView } from "./DesignerView";
import { DispatchView } from "./DispatchView";
import { FleetView } from "./FleetView";
import { LiveView } from "./LiveView";

type View = "live" | "dispatch" | "fleet" | "designer" | "analytics";

export default function App() {
  const { user, ready, signIn, signOut } = useAuth("tower");
  const refs = useRefs();
  const [view, setView] = useLocalState<View>("tower.view", "live");
  const [siteId, setSiteIdRaw] = useLocalState<string | null>("tower.site", null);
  const setSiteId = useCallback((id: string) => setSiteIdRaw(id), [setSiteIdRaw]);
  const needsSite = view === "live" || view === "designer" || view === "analytics";

  if (!ready) return null;
  if (!user) return <LoginPage onSubmit={signIn} />;

  return (
    <Shell
      mark="CT"
      title="CoreLogistics"
      role="Control Tower"
      onSwitchRole={() => void signOut()}
      nav={[
        { id: "live", label: "Live site" },
        { id: "dispatch", label: "Dispatch" },
        { id: "fleet", label: "Fleet" },
        { id: "designer", label: "Site designer" },
        { id: "analytics", label: "Analytics" },
      ]}
      navValue={view}
      onNav={(id) => setView(id as View)}
      right={
        <>
          {needsSite ? <SitePicker sites={refs.sites} value={siteId} onChange={setSiteId} /> : null}
          <ActorBadge placeholder="Planner name" />
        </>
      }
    >
      {view === "live" && siteId ? <LiveView siteId={siteId} refs={refs} /> : null}
      {view === "dispatch" ? <DispatchView refs={refs} /> : null}
      {view === "fleet" ? <FleetView refs={refs} /> : null}
      {view === "designer" && siteId ? <DesignerView siteId={siteId} /> : null}
      {view === "analytics" && siteId ? <AnalyticsView siteId={siteId} refs={refs} /> : null}
    </Shell>
  );
}
