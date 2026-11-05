# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Four operator roles, each with its own app:

- Control tower planners dispatch trips, watch the live site, manage fleet, edit the site map, and read analytics.
- Gate operators check trucks in and assign a yard slot and a dock.
- Warehouse floor staff receive, sort, put away, pick, and load.
- Drivers follow their trip, stops, and arrival.

## Product Purpose

CoreLogistics runs a distribution site from one operational record: trips, yard and dock state, warehouse work, and the people doing it. Success is an operator finishing the next real action without leaving their station.

## Positioning

One shared operation across tower, gate, warehouse, and driver, with the live site map as the common picture of where a truck and its freight are.

## Operating Context

Operators work at a desk (tower) or on the floor and in a cab (warehouse, gate, driver). The apps share sign-in, the site picker, and the actor name recorded on actions. Demo accounts exist for each station.

## Capabilities and Constraints

- Control tower views: live site, dispatch pipeline, fleet (vehicles, drivers, maintenance, devices), site designer, analytics.
- Gate, warehouse, and driver keep their own task screens. They share chrome with the tower and do not copy the tower’s layouts.
- Data comes from the CoreLogistics API. Sample figures in design mockups are not product data.
- Light is the default theme. Dark mode stays available.

## Brand Commitments

The visual system is the Apple Liquid Glass control tower in `d:\New folder (2)\testing.html`, which the user made binding: ambient mesh, frosted panels, Apple system hues, floating sidebar, and a dark glass sign-in card. That material is shared by every app. Control tower screen composition follows the mock. Warehouse, gate, and driver keep their task layouts inside the shared chrome.

## Evidence on Hand

Working React apps under `apps/control-tower`, `apps/gate`, `apps/warehouse`, and `apps/driver`, with shared UI in `packages/ui`. The liquid-glass reference is the HTML mock named above. Do not invent customers, benchmarks, or prices.

## Product Principles

- The next action stays visible.
- The same trip, site, and person mean the same thing in every app.
- Status is color plus a word, never color alone.
- Floor and cab screens stay large enough to use while standing or driving a task to completion.
