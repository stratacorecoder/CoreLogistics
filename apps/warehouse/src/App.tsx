import type { Order, PutawayTask, Receipt, Shipment } from "@corelogistics/contracts";
import { ActorBadge, LoginPage, qs, Shell, SitePicker, useApi, useAuth, useLocalState, useRefs } from "@corelogistics/ui";
import { useCallback, type ReactNode } from "react";
import { PickView } from "./PickView";
import RubberSegment from "./RubberSegment";
import { PutawayView } from "./PutawayView";
import { ReceiveView } from "./ReceiveView";
import { ShipView } from "./ShipView";
import { SortView } from "./SortView";
import { StockView } from "./StockView";

type View = "receive" | "sort" | "putaway" | "pick" | "ship" | "stock";

export default function App() {
  const { user, ready, signIn, signOut } = useAuth("warehouse");
  const refs = useRefs();
  const [view, setView] = useLocalState<View>("wh.view", "receive");
  const [siteId, setSiteIdRaw] = useLocalState<string | null>("wh.site", null);
  const setSiteId = useCallback((id: string) => setSiteIdRaw(id), [setSiteIdRaw]);

  const receipts = useApi<Receipt[]>(siteId ? `/warehouse/receipts${qs({ siteId, status: "open" })}` : null);
  const putaway = useApi<PutawayTask[]>(siteId ? `/warehouse/putaway${qs({ siteId, status: "open" })}` : null);
  const orders = useApi<Order[]>(siteId ? `/outbound/orders${qs({ siteId, status: "open,picking,picked" })}` : null);
  const shipments = useApi<Shipment[]>(siteId ? `/outbound/shipments${qs({ siteId, status: "planning,loading,loaded" })}` : null);

  if (!ready) return null;
  if (!user) return <LoginPage onSubmit={signIn} />;

  return (
    <Shell
      mark="WH"
      title="CoreLogistics"
      role="Warehouse floor"
      tone="floor"
      onSwitchRole={() => void signOut()}
      center={
        <RubberSegment
          items={[
            { value: "receive", label: tabLabel("Receive", receipts.data?.length) },
            { value: "sort", label: "Sort" },
            { value: "putaway", label: tabLabel("Putaway", putaway.data?.length) },
            { value: "pick", label: tabLabel("Pick & stage", orders.data?.length) },
            { value: "ship", label: tabLabel("Load", shipments.data?.length) },
            { value: "stock", label: "Stock" },
          ]}
          value={view}
          onChange={(next) => setView(next as View)}
          size="lg"
          radius={8}
          inset={3}
          equalSlots={false}
          stretch={100}
          squash={3}
          speed={1}
          glide={75}
          draggable
          aria-label="Warehouse floor"
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
          {view === "receive" ? <ReceiveView siteId={siteId} refs={refs} onSort={() => setView("sort")} /> : null}
          {view === "sort" ? <SortView siteId={siteId} refs={refs} onPutaway={() => setView("putaway")} /> : null}
          {view === "putaway" ? <PutawayView siteId={siteId} /> : null}
          {view === "pick" ? <PickView siteId={siteId} refs={refs} /> : null}
          {view === "ship" ? <ShipView siteId={siteId} refs={refs} /> : null}
          {view === "stock" ? <StockView siteId={siteId} /> : null}
        </div>
      ) : null}
    </Shell>
  );
}

function tabLabel(label: string, badge?: number): ReactNode {
  return badge ? (
    <>
      {label} <span className="tab-badge">{badge}</span>
    </>
  ) : (
    label
  );
}
