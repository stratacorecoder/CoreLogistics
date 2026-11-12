import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { assertFitsViewport, openSignedInRole, startE2ECluster, type E2ECluster } from "./harness.js";

describe("CoreLogistics E2E Suite", () => {
  let cluster: E2ECluster;

  before(async () => {
    cluster = await startE2ECluster();
  });

  after(async () => {
    await cluster?.stop();
  });

  it("signs in, navigates main views, and signs out cleanly across all 4 apps", async () => {
    // Control Tower
    const ct = await openSignedInRole(cluster.browser, cluster.urls.tower, "ava", "planner");
    try {
      await ct.page.getByText("IN YARD", { exact: true }).waitFor({ timeout: 10_000 });
      await ct.page.getByRole("button", { name: "Dispatch" }).click();
      await ct.page.getByRole("button", { name: "New trip" }).waitFor({ timeout: 10_000 });
      await ct.page.getByRole("button", { name: "Fleet" }).click();
      await ct.page.getByRole("button", { name: /^Vehicles/ }).waitFor({ timeout: 10_000 });
      await ct.page.getByRole("button", { name: "Site designer" }).click();
      await ct.page.getByRole("button", { name: "Save Layout" }).waitFor({ timeout: 10_000 });
      await ct.page.getByRole("button", { name: "Analytics" }).click();
      await ct.page.locator(".recharts-wrapper").first().waitFor({ timeout: 10_000 });
      await ct.page.getByRole("button", { name: "Sign out" }).click();
      await ct.page.locator("#signin-username").waitFor({ timeout: 5_000 });
      assert.deepEqual(ct.errors, []);
    } finally {
      await ct.context.close();
    }

    // Gate & Yard
    const gt = await openSignedInRole(cluster.browser, cluster.urls.gate, "rico", "yard");
    try {
      await gt.page.getByRole("button", { name: /^Expected/ }).waitFor({ timeout: 10_000 });
      await gt.page.getByRole("button", { name: /^Appointments/ }).click();
      await gt.page.getByRole("button", { name: "Book" }).waitFor({ timeout: 5_000 });
      await gt.page.getByRole("button", { name: "Gate log" }).click();
      await gt.page.getByRole("button", { name: "Sign out" }).click();
      await gt.page.locator("#signin-username").waitFor({ timeout: 5_000 });
      assert.deepEqual(gt.errors, []);
    } finally {
      await gt.context.close();
    }

    // Warehouse Floor
    const wh = await openSignedInRole(cluster.browser, cluster.urls.warehouse, "mina", "floor");
    try {
      await wh.page.getByText("Open receipts").waitFor({ timeout: 10_000 });
      for (const tab of [/^Sort$/, /^Putaway/, /^Pick & stage/, /^Load/, /^Stock$/]) {
        await wh.page.getByRole("button", { name: tab }).click();
      }
      await wh.page.getByText("Find a unit").waitFor({ timeout: 10_000 });
      await wh.page.getByText("Occupancy").waitFor({ timeout: 10_000 });
      await wh.page.getByRole("button", { name: "Sign out" }).click();
      await wh.page.locator("#signin-username").waitFor({ timeout: 5_000 });
      assert.deepEqual(wh.errors, []);
    } finally {
      await wh.context.close();
    }

    // Driver Cab
    const dr = await openSignedInRole(cluster.browser, cluster.urls.driver, "jose", "drive");
    try {
      await dr.page.getByText("Hi, Jose").waitFor({ timeout: 10_000 });
      await dr.page.getByRole("button", { name: "Sign out" }).click();
      await dr.page.locator("#signin-username").waitFor({ timeout: 5_000 });
      assert.deepEqual(dr.errors, []);
    } finally {
      await dr.context.close();
    }
  });

  it("propagates dispatched trips and gate check-ins across apps in real time via SSE", async () => {
    const ct = await openSignedInRole(cluster.browser, cluster.urls.tower, "ava", "planner");
    const dr = await openSignedInRole(cluster.browser, cluster.urls.driver, "grace", "drive");
    const gt = await openSignedInRole(cluster.browser, cluster.urls.gate, "rico", "yard");
    try {
      // Wait for Driver initial screen and Control Tower Dispatch
      await dr.page.getByText("Hi, Grace").waitFor({ timeout: 10_000 });
      await ct.page.getByRole("button", { name: "Dispatch" }).click();
      await ct.page.getByRole("button", { name: "New trip" }).click();

      const newModal = ct.page.locator(".modal");
      const vehicleSelect = newModal.getByLabel("Vehicle");
      const availableOpt = vehicleSelect.locator("option", { hasText: "Available" }).first();
      await availableOpt.waitFor({ state: "attached", timeout: 10_000 });
      const vehicleOpt = (await availableOpt.textContent()) ?? "";
      assert.ok(vehicleOpt.length > 0, "Expected an available vehicle option");

      const driverSelect = newModal.getByLabel("Driver");
      const graceOpt = driverSelect.locator("option", { hasText: "Grace Dela Cruz" }).first();
      await graceOpt.waitFor({ state: "attached", timeout: 10_000 });
      const driverOpt = (await graceOpt.textContent()) ?? "";
      assert.ok(driverOpt.length > 0, "Expected seeded Grace Dela Cruz option");

      await vehicleSelect.selectOption({ label: vehicleOpt });
      await driverSelect.selectOption({ label: driverOpt });
      await newModal.getByRole("button", { name: "Create trip" }).click();

      // TripModal opens once POST /trips resolves; dispatch it
      const tripHeading = ct.page.locator(".modal-head h3").filter({ hasText: /^TRP-/ });
      await tripHeading.waitFor({ timeout: 10_000 });
      const titleText = await tripHeading.textContent();
      const tripCode = titleText?.split("·")[0]?.trim();
      assert.ok(tripCode && tripCode.startsWith("TRP-"), `Expected trip code in ${titleText}`);
      await ct.page.locator(".modal").getByRole("button", { name: "Dispatch" }).click();
      await ct.page.locator(".modal").getByRole("button", { name: "Mark departed" }).waitFor({ timeout: 10_000 });
      await ct.page.locator(".modal").getByRole("button", { name: "Close" }).click();

      // Driver app updates live over SSE without page.reload()
      await dr.page.getByText(tripCode).first().waitFor({ timeout: 10_000 });

      // Gate checks in that dispatched truck -> appears live in Control Tower Live site without page.reload()
      const plate = vehicleOpt.split("·")[1]?.trim() ?? "";
      assert.ok(plate.length > 0, `Expected vehicle plate in option "${vehicleOpt}"`);
      await ct.page.getByRole("button", { name: "Live site" }).click();
      await gt.page.getByPlaceholder("PLATE").fill(plate);
      await gt.page.getByRole("button", { name: "Check in" }).click();
      await gt.page.locator(".modal").getByRole("button", { name: "Open gate" }).click();
      await gt.page.locator(".modal").waitFor({ state: "detached", timeout: 10_000 });

      await ct.page.getByText(plate).first().waitFor({ timeout: 10_000 });

      assert.deepEqual(ct.errors, []);
      assert.deepEqual(dr.errors, []);
      assert.deepEqual(gt.errors, []);
    } finally {
      await Promise.all([ct.context.close(), dr.context.close(), gt.context.close()]);
    }
  });

  it("renders key views without horizontal overflow on mobile (390x844)", async () => {
    const mobile = { width: 390, height: 844 };

    const ct = await openSignedInRole(cluster.browser, cluster.urls.tower, "ava", "planner", mobile);
    try {
      await ct.page.getByText("IN YARD", { exact: true }).waitFor({ timeout: 10_000 });
      await assertFitsViewport(ct.page, "Control Tower Live (mobile)");
      await ct.page.getByRole("button", { name: "Dispatch" }).click();
      await ct.page.getByRole("button", { name: "New trip" }).waitFor({ timeout: 10_000 });
      await assertFitsViewport(ct.page, "Control Tower Dispatch (mobile)");
      assert.deepEqual(ct.errors, []);
    } finally {
      await ct.context.close();
    }

    const wh = await openSignedInRole(cluster.browser, cluster.urls.warehouse, "mina", "floor", mobile);
    try {
      await wh.page.getByText("Open receipts").waitFor({ timeout: 10_000 });
      await assertFitsViewport(wh.page, "Warehouse Receive (mobile)");
      await wh.page.getByRole("button", { name: /^Stock$/ }).click();
      await wh.page.getByText("Occupancy").waitFor({ timeout: 10_000 });
      await assertFitsViewport(wh.page, "Warehouse Stock (mobile)");
      assert.deepEqual(wh.errors, []);
    } finally {
      await wh.context.close();
    }

    const gt = await openSignedInRole(cluster.browser, cluster.urls.gate, "rico", "yard", mobile);
    try {
      await gt.page.getByPlaceholder("PLATE").waitFor({ timeout: 10_000 });
      await assertFitsViewport(gt.page, "Gate (mobile)");
      assert.deepEqual(gt.errors, []);
    } finally {
      await gt.context.close();
    }

    const dr = await openSignedInRole(cluster.browser, cluster.urls.driver, "jose", "drive", mobile);
    try {
      await dr.page.getByText("Hi, Jose").waitFor({ timeout: 10_000 });
      await assertFitsViewport(dr.page, "Driver (mobile)");
      assert.deepEqual(dr.errors, []);
    } finally {
      await dr.context.close();
    }
  });

  it("completes Warehouse receive -> sort -> putaway -> pick -> stage -> build shipment flow", async () => {
    const wh = await openSignedInRole(cluster.browser, cluster.urls.warehouse, "mina", "floor");
    const huCode = "HU-E2E-001";
    try {
      await wh.page.getByText("Open receipts").waitFor({ timeout: 10_000 });

      // 1. Open a walk-in receipt and receive a unit
      await wh.page.getByRole("button", { name: "New", exact: true }).click();
      const modal = wh.page.locator(".modal");
      await modal.getByPlaceholder(/Cavite/i).fill("E2E Supplier");
      await modal.getByRole("button", { name: "Open receipt" }).click();
      await modal.waitFor({ state: "detached", timeout: 10_000 });

      await wh.page.getByPlaceholder("AUTO PRINT").fill(huCode);
      await wh.page.getByRole("button", { name: "Receive Unit" }).click();
      await wh.page.getByText(huCode).first().waitFor({ timeout: 10_000 });

      // 2. Sort the unit via manual CameraScanner modal fallback (verifies CameraScanner + Sort flow)
      await wh.page.getByRole("button", { name: /^Sort/ }).first().click();
      await wh.page.getByRole("button", { name: "Scan" }).click();
      await wh.page.getByPlaceholder(/type\/paste barcode manually/i).fill(huCode);
      await wh.page.getByRole("button", { name: "Submit" }).click();
      await wh.page.getByText("Take to lane").waitFor({ timeout: 10_000 });

      // 3. Putaway the sorted unit
      await wh.page.getByRole("button", { name: /^Putaway/ }).click();
      await wh.page.getByRole("button", { name: new RegExp(huCode) }).click();
      await wh.page.getByRole("button", { name: /^Confirm stored in / }).click();

      // 4. Create an order, release picks, confirm pick, and stage
      await wh.page.getByRole("button", { name: /^Pick & stage/ }).click();
      await wh.page.getByRole("button", { name: "New order" }).click();
      const orderModal = wh.page.locator(".modal");
      await orderModal.getByRole("button", { name: "Create order" }).click();
      await orderModal.waitFor({ state: "detached", timeout: 10_000 });

      await wh.page.getByRole("button", { name: /Release to floor/i }).click();
      await wh.page.getByRole("button", { name: "Picked", exact: true }).first().click();
      await wh.page.getByRole("button", { name: /^Stage \d+ units/ }).click();
      await wh.page.getByText(/Staged and waiting for a shipment/i).waitFor({ timeout: 10_000 });

      // 5. Build a shipment for the staged order
      await wh.page.getByRole("button", { name: /^Load/ }).click();
      await wh.page.getByRole("button", { name: "Build shipment" }).click();
      const shipModal = wh.page.locator(".modal");
      await shipModal.locator('input[type="checkbox"]').first().check();
      await shipModal.getByRole("button", { name: "Create shipment" }).click();
      await shipModal.waitFor({ state: "detached", timeout: 10_000 });
      await wh.page.getByText(/Units \(\d+\/\d+ loaded\)/).waitFor({ timeout: 10_000 });

      assert.deepEqual(wh.errors, []);
    } finally {
      await wh.context.close();
    }
  });

  it("returns open UI tabs to sign-in when server session expires (401 recovery)", async () => {
    const wh = await openSignedInRole(cluster.browser, cluster.urls.warehouse, "mina", "floor");
    try {
      await wh.page.getByText("Open receipts").waitFor({ timeout: 10_000 });
      // Clear browser cookies to simulate expired/revoked server session
      await wh.context.clearCookies();

      // Trigger an authenticated mutation/read via the UI
      await wh.page.getByRole("button", { name: "New", exact: true }).click();
      const modal = wh.page.locator(".modal");
      await modal.getByPlaceholder(/Cavite/i).fill("Expired Session Test");
      await modal.getByRole("button", { name: "Open receipt" }).click();

      // UI should automatically clear user & SSE and render the sign-in screen
      await wh.page.locator("#signin-username").waitFor({ timeout: 10_000 });
      assert.ok(wh.errors.every((e) => e.startsWith("HTTP 401 ")), `Unexpected errors: ${wh.errors.join(", ")}`);
    } finally {
      await wh.context.close();
    }
  });
});
