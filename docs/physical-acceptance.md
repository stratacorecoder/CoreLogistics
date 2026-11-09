# Physical acceptance

Stage 5b is done by people on the devices below. Record every result on this sheet. A failed step blocks the release. Auto-Pilot stays off for the whole session.

## Devices

Fill this in before any scan.

| Role | Device | OS version | Browser | Browser version | Tester | Date |
| --- | --- | --- | --- | --- | --- | --- |
| Warehouse handheld | Android | | Chrome | | | |
| Driver phone | Android | | Chrome | | | |
| Driver phone | iPhone | | Safari | | | |

Use the production-like HTTPS origin. A raw `http://` address is not a valid camera test. The page must be served from that secure origin, not a file or an embedded preview.

Labels must be real warehouse labels, not screenshots: one handling-unit barcode that belongs to an open task, one bin barcode at that site, one wrong label, and one delivery-note barcode. Note the codes here:

| Label | Code |
| --- | --- |
| Open putaway unit | |
| Its suggested or chosen bin | |
| Open pick pallet | |
| Wrong label | |
| Delivery note | |

## Lighting and connection

Run the warehouse scans three times: normal aisle light, a darker aisle or shaded dock, and a bright glare on the label. For each, note whether the rear camera reads the code or the tester has to type it.

Then repeat one successful warehouse confirm with the radio in airplane mode until the request fails, turn the radio back on, and submit again without retyping.

## Warehouse handheld (Android Chrome)

Sign in as a warehouse floor user. The floor app does not offer a Tower bypass.

1. Putaway. Open the scanner from the unit field. Confirm the preview is the rear camera. Deny camera permission once, then allow it from the browser prompt and use **Allow camera**. The same unit code must reach the field.
2. Leave the app or lock the phone. The scanner must say the camera paused. It must not start again until **Resume camera** is tapped.
3. Scan the real unit label and the real bin label. The screen must say the code was detected and that stock is not confirmed yet. Submit. The success text must say the stock was confirmed, and the unit must show in that bin.
4. On a second task, scan or type the wrong label. The error must name the expected unit or pallet. Both entered codes must stay on screen. Correct the code and submit with the same attempt. Stock must move once.
5. Type a code with the handheld keyboard into the same fields used by the camera. Submit. The result must match a camera confirm.
6. If the torch control is shown, turn it on and off. If it is absent, record that this device reported no torch.
7. Scan a Code 128 or QR label and, if you have them, a Code 39, EAN, or UPC label. Record any format the rear camera cannot read. Manual entry of that code must still submit.

## Driver phones (Android Chrome and iPhone Safari)

Use a trip that is assigned to the signed-in driver and has reached the delivery stop.

1. Open the scanner from the delivery-note control. The caption must say a scanned code is stored as a delivery-note reference and does not prove the document or the seal.
2. Deny permission, recover it, and scan the real delivery-note barcode. The note must contain that code. Completing the stop must not change stock or confirm a seal.
3. Lock the phone during the scan, then resume only with the on-screen control.
4. Turn the radio off, try to complete the stop, and confirm the form keeps the note. Turn the radio on and submit once.

Repeat every driver step on both phones.

## Control Tower sign-off

On a desktop session as a Tower planner, with Auto-Pilot still off:

1. Open Copilot. With the worker running and no pending rows, the drawer says **No pending recommendations** and lists only trip issues, trip updates, dispatch, departure, arrival, stop arrival, stop departure, completion, and cancellation. It must not mention telematics, gate check-ins, or dock doors as watched sources.
2. Stop the API or disconnect the browser. The badge must say it is disconnected and must not claim there are no recommendations unless a successful fetch already showed an empty list.
3. Create one failed disruption job in a disposable copy, or use a job that is already failed. The drawer must show the failure and a Tower retry. A warehouse login must not be able to retry it.
4. If a pending recommendation has no executable action, **1-Click Apply** stays disabled and Dismiss still works.
5. Apply one eligible recommendation once. A second apply must not move the appointment or the dock again.

Ops owners sign that floor execution stays manual, and that automatic execution, when it is later switched on, is limited to low and medium appointment reschedules. Dock swaps and high or critical disruptions stay with Tower. Do not switch Auto-Pilot on for this release.

| Check | Owner | Accepted | Date |
| --- | --- | --- | --- |
| Warehouse handheld scans and confirms | | | |
| Android driver reference capture | | | |
| iPhone driver reference capture | | | |
| Manual Tower execution only | | | |
| Auto-Pilot remains off | | | |
