# Ten-step flow, as it ran

Walked in the live apps on 29 Oct 2026, about 11:03–11:10 AM. Screenshots are in this folder. A silent playback of the same frames is [ten-step-flow.mp4](ten-step-flow.mp4).

Two threads share the morning, because one truck does not both receive inbound freight and deliver a different customer's order.

- **Outbound milk run.** Trip `TRP-1053`, truck `T09` plate `NIB 4433`, driver Grace Dela Cruz. WH-C → Makati Retail Hub → QC Superstore. This is steps 1–3 and 8–10.
- **Warehouse floor.** Receipt `RCV-1026` (already open from Cavite Manufacturing, truck `NCH 4211` at dock D02) and order `ORD-1022` (Pampanga). This is steps 4–7. The units loaded onto `TRP-1053` were the already-staged QC order `ORD-1020` on shipment `SHP-1020`, because that customer matches the truck at D04. `ORD-1022` stays staged at S02 until a Pampanga truck is at a dock.

Names typed in the corner are the actors on the event log: Ava Chen (planner), Rico Santos (guard), Mina Cruz (warehouse).

## 1. Dispatch the trip

Control Tower → Dispatch. Ava Chen opened `TRP-1053` and dispatched it. The log line is `trip.dispatched`.

![Dispatch board with TRP-1053 dispatched](01-dispatch.png)

## 2. Check in at the gate

Gate & Yard, site WH-C. Rico Santos entered plate `NIB 4433`. The check-in dialog auto-matched `TRP-1053` and assigned yard slot Y03.

![Check-in dialog for NIB 4433](02-check-in.png)

![Truck in the yard at Y03](03-on-site.png)

Event: `gate.check_in` — "NIB 4433 checked in at WH-C for TRP-1053, parked at Y03".

## 3. Send the truck to a dock

The gate suggested door D04. This visit is an outbound load, so docking it does not open a receipt. A receipt opens when an inbound truck is sent to a door to unload. That inbound receipt is already `RCV-1026`.

![Suggested dock D04](04-dock-suggest.png)

![NIB 4433 at dock D04](05-at-dock.png)

Event: `dock.assigned` — "NIB 4433 to D04 to load".

## 4. Receive freight

Warehouse floor → Receive, receipt `RCV-1026`. Mina Cruz received 20 of laundry detergent `HH-DET-4` as pallet `HU-100177`. Received quantity on that line moved from 0 to 20.

![Receipt before the new unit](06-receive.png)

![HU-100177 on the receipt](07-received.png)

Event: `hu.received` — "HU-100177: 20 × HH-DET-4 received on RCV-1026".

## 5. Sort to a lane

Sort sent `HU-100177` to lane L01 and created a putaway task for bin R01-1.

![Unit waiting to sort](08-sort-queue.png)

![Sorted to lane L01](09-sorted.png)

Events: `hu.sorted`, `putaway.created`.

## 6. Confirm the bin

Putaway confirmed the suggestion. `HU-100177` is stored in R01-1.

![Suggested bin R01-1](10-putaway.png)

![After confirm](11-putaway-done.png)

Event: `putaway.done` — "HU-100177 stored in R01-1".

## 7. Pick and stage

Pick & stage, order `ORD-1022` (open, customer CUS-PAM). Release allocated two picks FIFO. Both were confirmed, then the order was staged at lane S02.

![ORD-1022 before release](12-pick-order.png)

![Pick list](13-pick-list.png)

![Order staged](14-staged.png)

Events: `order.released`, two `pick.done` lines (13 × BEV-COLA-24 and 15 × SNK-NUTS-20), `order.staged` — "Order ORD-1022 staged at S02 (2 HU)".

Those units are not on `TRP-1053`. That trip does not go to Pampanga, and the load screen refuses a truck that is not at a dock for that destination.

## 8. Load the truck

Shipment `SHP-1020` already held staged QC order `ORD-1020`. The trip on the shipment was changed to `TRP-1053`. Because NIB 4433 was at D04, Load all staged moved 4 units (291 kg of 1.2 t, 0.9 of 8 m³).

![Shipment ready at D04](15-load-ready.png)

![Four units loaded](16-loaded.png)

Event: `hu.loaded` — "4 HU loaded on SHP-1020 at D04 (291 kg)".

## 9. Check out and depart

Back at the gate, Rico Santos checked out `NIB 4433`. Dwell was 4 minutes. Checkout also departed the trip.

![Plate entered for checkout](17-checkout.png)

![After checkout](18-checked-out.png)

Events: `gate.check_out`, `trip.departed` — "Trip TRP-1053 WH-C → CUS-QC departed".

## 10. Arrive and finish

Driver app, Grace Dela Cruz. She marked the Makati stop, left it, confirmed arrival at QC Superstore, then finished the trip.

![Trip in transit, origin already left](19-driver-trip.png)

![Arrived at QC Superstore](20-driver-arrived.png)

![Arrival recorded on the trip log](21-driver-done.png)

Events: `trip.stop_arrived`, `trip.stop_departed`, `trip.arrived` ("arrived on time"), `trip.completed`. Final status of `TRP-1053` is `completed`.
