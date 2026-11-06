---
name: CoreLogistics
description: Frosted operations desk on an ambient mesh for tower, gate, warehouse, and driver.
colors:
  apple-blue: "#0066cc"
  apple-blue-bright: "#007aff"
  apple-green: "#157a34"
  apple-green-bright: "#34c759"
  apple-orange: "#9a4d00"
  apple-orange-bright: "#ff9500"
  apple-red: "#d70015"
  apple-red-bright: "#ff3b30"
  apple-purple: "#5856d6"
  apple-teal: "#30b0c7"
  ink: "#0f172a"
  ink-soft: "#475569"
  mesh-1: "#e0eafc"
  mesh-2: "#cfdef3"
  mesh-3: "#f3e7e9"
  glass: "rgba(255, 255, 255, 0.66)"
  glass-strong: "rgba(255, 255, 255, 0.86)"
  glass-subtle: "rgba(255, 255, 255, 0.46)"
  obsidian: "rgba(15, 21, 35, 0.72)"
  on-accent: "#ffffff"
  map-gate: "#0066cc"
  map-dock: "#157a34"
  map-staging: "#c2410c"
  map-office: "#5856d6"
  map-rack: "#7c3aed"
  map-busy: "#c2410c"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Inter, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "-0.01em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Inter, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  data:
    fontFamily: "SF Mono, JetBrains Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
rounded:
  sm: "10px"
  md: "16px"
  lg: "22px"
  shell: "24px"
  pill: "999px"
spacing:
  shell: "12px"
  stack: "10px"
  panel: "16px"
components:
  button-primary:
    backgroundColor: "{colors.apple-blue}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
  button-ghost:
    backgroundColor: "{colors.glass-subtle}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 14px"
  panel:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "14px 16px"
  input:
    backgroundColor: "{colors.glass-strong}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "8px 12px"
  nav-item-active:
    backgroundColor: "rgba(0, 102, 204, 0.14)"
    textColor: "{colors.apple-blue}"
    rounded: "{rounded.sm}"
    padding: "8px 11px"
---

## Overview

**Creative North Star: "Frosted operations desk."**

CoreLogistics is a desk you can see the yard through. Panels are glass over an ambient mesh, not solid cards on a flat page. The same material wraps the control tower, the gate, the warehouse floor, and the driver cab. Tower screens keep the mock's jobs: live site, dispatch, fleet, designer, analytics. The other apps keep their own tasks inside that chrome.

**Key Characteristics:**

- Three glass levels: default, strong, and subtle, each with blur, a hairline, and an inset highlight.
- An ambient mesh of blue, purple, teal, and green, light by default and dark when the operator switches.
- Apple hues for status, darkened where white or light text would fail contrast.
- JetBrains Mono only for plates, trip ids, counts, and the clock.

## Colors

Status color is a fill or a word in a darker ink of the same hue. Bright Apple green and orange are for dots and large fills with dark text, not for small type on white glass.

**The Ink Rule.** Body text is ink or ink-soft on light glass, and near-white on dark glass. Gray on a tinted surface is not a secondary color.

## Typography

UI text is the system face, with Inter as the webfont. Data text is JetBrains Mono at the same size as the surrounding label, not a display costume.

**The Data Face Rule.** Mono is for identifiers, durations, and counts. Labels stay in the UI face.

## Layout

The signed-in tower is a floating sidebar and a glass header inset 12px from the mesh. Live is three columns: KPIs and who is on site, the spatial map, then trips and activity. Dispatch is a filter bar over five pipeline columns. Below 1100px the sidebar becomes a horizontal strip and those boards stack so the map stays on screen. Warehouse and gate keep a single top bar; the floor uses a larger type size.

## Elevation & Depth

Depth is a soft offset shadow plus the glass border. Hover lifts a card or a map cell; it does not add a colored halo with no offset. The sign-in card is the darkest, heaviest pane.

## Shapes

Shells are 20–24px. Panels are 20px. Controls and inputs are 12px. Status chips and the live pill are fully round. Map cells stay at 6px so a full site still fits.

## Components

- Sidebar: glass, 24px radius, active item is a blue tint with no side stripe.
- Header: strong glass, view name on the left, site, operator, live, clock, and theme on the right.
- Panel: default glass, title and actions on one row that may wrap.
- Primary button: blue gradient, white label, press scales to 0.98.
- Trip card and KPI: strong glass, 16px radius. Delayed and warning states use an inset ring, not a left bar.
- Map cell: lifts slightly on hover. Occupied yard slots are orange; docks and gates use the map tokens, darkened so white labels clear contrast.

## Do's and Don'ts

- Do keep real trip, plate, and site data in the glass. Do not paste sample counts from the mock.
- Do use the shared shell for every app. Do not rebuild warehouse, gate, or driver into the tower's five-column layouts.
- Do pair a status color with a word.
- Don't put a left stripe on cards or nav items.
- Don't use IBM Plex, gradient text, or a flat white page behind the panels.
- Don't put small white type on Apple green or Apple orange.
