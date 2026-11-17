import type { CopilotLink } from "@corelogistics/contracts";
import { ActorBadge, CopilotBadge, CopilotDrawer, DeskNotice, LoginPage, SitePicker, Shell, useAuth, useLocalState, useRefs } from "@corelogistics/ui";
import { BarChart3, CalendarClock, Globe, LayoutGrid, Radio, Truck } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { LiveView } from "./LiveView";

const loadNetwork = () => import("./NetworkMapView");
const loadDispatch = () => import("./DispatchView");
const loadFleet = () => import("./FleetView");
const loadDesigner = () => import("./DesignerView");
const loadAnalytics = () => import("./AnalyticsView");

const NetworkMapView = lazy(() => loadNetwork().then((m) => ({ default: m.NetworkMapView })));
const DispatchView = lazy(() => loadDispatch().then((m) => ({ default: m.DispatchView })));
const FleetView = lazy(() => loadFleet().then((m) => ({ default: m.FleetView })));
const DesignerView = lazy(() => loadDesigner().then((m) => ({ default: m.DesignerView })));
const AnalyticsView = lazy(() => loadAnalytics().then((m) => ({ default: m.AnalyticsView })));

type View = "live" | "network" | "dispatch" | "fleet" | "designer" | "analytics";

export default function App() {
  const { user, ready, signIn, signOut } = useAuth("tower");
  const refs = useRefs(Boolean(user));
  const [view, setView] = useLocalState<View>("tower.view", "live");
  const [siteId, setSiteIdRaw] = useLocalState<string | null>("tower.site", null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [place, setPlace] = useState<{ view: View; query: string; key: number } | null>(null);
  const setSiteId = useCallback((id: string) => setSiteIdRaw(id), [setSiteIdRaw]);
  const needsSite = view === "live" || view === "designer" || view === "analytics";

  useEffect(() => {
    if (!user) return;
    const id = window.setTimeout(() => {
      void loadNetwork();
      void loadDispatch();
      void loadFleet();
      void loadDesigner();
      void loadAnalytics();
    }, 250);
    return () => window.clearTimeout(id);
  }, [user]);

  if (!ready) return null;
  if (!user) return <LoginPage onSubmit={signIn} />;

  return (
    <>
    <Shell
      mark="CT"
      title="CoreLogistics"
      role="Control Tower"
      onSwitchRole={() => void signOut()}
      nav={[
        { id: "live", label: "Live site", icon: Radio },
        { id: "network", label: "Network", icon: Globe },
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
      <Suspense fallback={null}>
        {view === "live" && siteId ? (
          <LiveView
            siteId={siteId}
            refs={refs}
            focus={place?.view === "live" ? place : null}
            onOpenTrip={(code) => {
              setView("dispatch");
              setPlace({ view: "dispatch", query: code, key: Date.now() });
            }}
            onOpenAnalytics={() => setView("analytics")}
          />
        ) : null}
        {view === "network" ? (
          <NetworkMapView
            refs={refs}
            onOpenSite={(id) => {
              setSiteId(id);
              setView("live");
            }}
            onOpenDesigner={(id) => {
              setSiteId(id);
              setView("designer");
            }}
            onOpenTrip={(code) => {
              setView("dispatch");
              setPlace({ view: "dispatch", query: code, key: Date.now() });
            }}
          />
        ) : null}
        {view === "dispatch" ? (
          <DispatchView
            refs={refs}
            focus={place?.view === "dispatch" ? place : null}
            onOpenDesigner={(id) => {
              setSiteId(id);
              setView("designer");
            }}
          />
        ) : null}
        {view === "fleet" ? <FleetView refs={refs} focus={place?.view === "fleet" ? place : null} /> : null}
        {view === "designer" && siteId ? <DesignerView siteId={siteId} onSiteCreated={(id) => setSiteId(id)} /> : null}
        {view === "analytics" && siteId ? (
          <AnalyticsView
            siteId={siteId}
            refs={refs}
            onNavigate={(nextView) => setView(nextView)}
            onOpenCopilot={() => setCopilotOpen(true)}
          />
        ) : null}
      </Suspense>
      {copilotOpen ? (
        <CopilotDrawer
          siteId={siteId}
          onClose={() => setCopilotOpen(false)}
          onOpen={(link: CopilotLink) => {
            setView(link.view);
            setPlace({ view: link.view, query: link.focus ?? "", key: Date.now() });
            setCopilotOpen(false);
          }}
        />
      ) : null}
    </Shell>
    <DeskNotice desk="tower" />
    </>
  );
}
