import type { Order, PutawayTask, Receipt, Shipment } from "@corelogistics/contracts";
import { ActorBadge, DeskNotice, Empty, LoginPage, NudgeBanner, qs, Shell, SitePicker, Tabs, useApi, useAuth, useLocalState, useRefs } from "@corelogistics/ui";
import { lazy, Suspense, useCallback } from "react";
import { ReceiveView } from "./ReceiveView";

const SortView = lazy(() => import("./SortView").then((m) => ({ default: m.SortView })));
const PutawayView = lazy(() => import("./PutawayView").then((m) => ({ default: m.PutawayView })));
const PickView = lazy(() => import("./PickView").then((m) => ({ default: m.PickView })));
const ShipView = lazy(() => import("./ShipView").then((m) => ({ default: m.ShipView })));
const StockView = lazy(() => import("./StockView").then((m) => ({ default: m.StockView })));

type View = "receive" | "sort" | "putaway" | "pick" | "ship" | "stock";

export default function App() {
  const { user, ready, signIn, signOut } = useAuth("warehouse");
  const refs = useRefs(Boolean(user));
  const [view, setView] = useLocalState<View>("wh.view", "receive");
  const [siteId, setSiteIdRaw] = useLocalState<string | null>("wh.site", null);
  const setSiteId = useCallback((id: string) => setSiteIdRaw(id), [setSiteIdRaw]);

  const activeSite = user && siteId ? siteId : null;
  const receipts = useApi<Receipt[]>(activeSite ? `/warehouse/receipts${qs({ siteId: activeSite, status: "open" })}` : null, {
    live: (e) => e.type.startsWith("receipt.") || e.type === "hu.received" || e.type === "dock.assigned",
  });
  const putaway = useApi<PutawayTask[]>(activeSite ? `/warehouse/putaway${qs({ siteId: activeSite, status: "open" })}` : null, {
    live: (e) => e.type.startsWith("putaway.") || e.type === "hu.sorted",
  });
  const orders = useApi<Order[]>(activeSite ? `/outbound/orders${qs({ siteId: activeSite, status: "open,picking,picked" })}` : null, {
    live: (e) => e.type.startsWith("order.") || e.type === "pick.done",
  });
  const shipments = useApi<Shipment[]>(activeSite ? `/outbound/shipments${qs({ siteId: activeSite, status: "planning,loading,loaded" })}` : null, {
    live: (e) => e.type.startsWith("shipment.") || e.type === "hu.loaded" || e.type === "dock.assigned",
  });

  if (!ready) return null;
  if (!user) return <LoginPage onSubmit={signIn} />;

  return (
    <>
    <Shell
      mark="WH"
      title="CoreLogistics"
      role="Warehouse floor"
      tone="floor"
      onSwitchRole={() => void signOut()}
      center={
        <Tabs<View>
          value={view}
          onChange={setView}
          options={[
            { id: "receive", label: "Receive", badge: receipts.data?.length },
            { id: "sort", label: "Sort" },
            { id: "putaway", label: "Putaway", badge: putaway.data?.length },
            { id: "pick", label: "Pick & stage", badge: orders.data?.length },
            { id: "ship", label: "Load", badge: shipments.data?.length },
            { id: "stock", label: "Stock" },
          ]}
        />
      }
      right={
        <>
          <SitePicker sites={refs.sites} value={siteId} onChange={setSiteId} kinds={["warehouse", "depot"]} />
          <ActorBadge placeholder="Worker name" />
        </>
      }
    >
      {siteId ? (
        <div className="wh" style={{ display: "contents" }}>
          <NudgeBanner role="warehouse" siteId={siteId} />
          <Suspense fallback={<div className="page"><Empty>Loading…</Empty></div>}>
            {view === "receive" ? <ReceiveView siteId={siteId} refs={refs} onSort={() => setView("sort")} /> : null}
            {view === "sort" ? <SortView siteId={siteId} refs={refs} onPutaway={() => setView("putaway")} /> : null}
            {view === "putaway" ? <PutawayView siteId={siteId} canOverride={user.role === "tower"} /> : null}
            {view === "pick" ? <PickView siteId={siteId} refs={refs} canOverride={user.role === "tower"} /> : null}
            {view === "ship" ? <ShipView siteId={siteId} refs={refs} /> : null}
            {view === "stock" ? <StockView siteId={siteId} /> : null}
          </Suspense>
        </div>
      ) : null}
    </Shell>
    <DeskNotice desk="warehouse" />
    </>
  );
}
