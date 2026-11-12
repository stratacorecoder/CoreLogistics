import { ActorBadge, CopilotBadge, CopilotDrawer, Empty, LoginPage, SitePicker, Shell, useAuth, useLocalState, useRefs } from "@corelogistics/ui";
import { BarChart3, CalendarClock, LayoutGrid, Radio, Truck } from "lucide-react";
import { lazy, Suspense, useCallback, useState } from "react";
import { LiveView } from "./LiveView";

const DispatchView = lazy(() => import("./DispatchView").then((m) => ({ default: m.DispatchView })));
const FleetView = lazy(() => import("./FleetView").then((m) => ({ default: m.FleetView })));
const DesignerView = lazy(() => import("./DesignerView").then((m) => ({ default: m.DesignerView })));
const AnalyticsView = lazy(() => import("./AnalyticsView").then((m) => ({ default: m.AnalyticsView })));

type View = "live" | "dispatch" | "fleet" | "designer" | "analytics";

export default function App() {
  const { user, ready, signIn, signOut } = useAuth("tower");
  const refs = useRefs(Boolean(user));
  const [view, setView] = useLocalState<View>("tower.view", "live");
  const [siteId, setSiteIdRaw] = useLocalState<string | null>("tower.site", null);
  const [copilotOpen, setCopilotOpen] = useState(false);
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
        { id: "live", label: "Live site", icon: Radio },
        { id: "dispatch", label: "Dispatch", icon: CalendarClock },
        { id: "fleet", label: "Fleet", icon: Truck },
        { id: "designer", label: "Site designer", icon: LayoutGrid },
        { id: "analytics", label: "Analytics", icon: BarChart3 },
      ]}
      navValue={view}
      onNav={(id) => setView(id as View)}
      right={
        <>
          <CopilotBadge siteId={siteId} onOpen={() => setCopilotOpen(true)} />
          {needsSite ? <SitePicker sites={refs.sites} value={siteId} onChange={setSiteId} /> : null}
          <ActorBadge placeholder="Planner name" />
        </>
      }
    >
      <Suspense fallback={<div className="page"><Empty>Loading…</Empty></div>}>
        {view === "live" && siteId ? <LiveView siteId={siteId} refs={refs} /> : null}
        {view === "dispatch" ? <DispatchView refs={refs} /> : null}
        {view === "fleet" ? <FleetView refs={refs} /> : null}
        {view === "designer" && siteId ? <DesignerView siteId={siteId} /> : null}
        {view === "analytics" && siteId ? <AnalyticsView siteId={siteId} refs={refs} /> : null}
      </Suspense>
      {copilotOpen ? <CopilotDrawer siteId={siteId} onClose={() => setCopilotOpen(false)} /> : null}
    </Shell>
  );
}
