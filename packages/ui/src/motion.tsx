import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { useEffect, useRef, type RefObject } from "react";

gsap.registerPlugin(useGSAP);

const ENTER =
  ".panel, .trip-card, .live-kpi-card, .wh-kpi-item, .on-site-truck-card, .wh-receipt-card, .gate-expected-item, .modal, .toast";

const SKIP = ".site-map-frame, .map-wrap, .table, .list, .activity-timeline-list";

function harvest(node: Node, out: Element[]) {
  if (!(node instanceof Element) || out.length >= 16) return;
  if (node.matches(SKIP) || node.closest(SKIP)) return;
  if (node.matches(ENTER)) {
    if (!node.parentElement?.closest(ENTER)) out.push(node);
    return;
  }
  for (const child of node.children) harvest(child, out);
}

function play(nodes: Element[], seen: WeakSet<Element>) {
  const fresh = nodes.filter((node) => {
    if (seen.has(node)) return false;
    seen.add(node);
    return true;
  });
  if (!fresh.length) return;
  gsap.from(fresh, {
    autoAlpha: 0,
    y: 12,
    duration: 0.32,
    stagger: { each: 0.02, ease: "none" },
    ease: "power2.out",
    clearProps: "opacity,visibility,transform",
  });
}

/** Animate the first screen of panels, then only newly opened views, dialogs, and toasts. */
export function watchEntrances(root: ParentNode): () => void {
  const seen = new WeakSet<Element>();
  const pending: Element[] = [];
  let frame = 0;

  const flush = () => {
    frame = 0;
    if (!pending.length) return;
    const batch = pending.splice(0, pending.length);
    play(batch, seen);
  };

  const queue = (nodes: Element[]) => {
    if (!nodes.length) return;
    pending.push(...nodes);
    if (!frame) frame = requestAnimationFrame(flush);
  };

  if (root instanceof Element) {
    const initial: Element[] = [];
    for (const child of root.children) harvest(child, initial);
    queue(initial);
  }

  const observer = new MutationObserver((records) => {
    const found: Element[] = [];
    for (const record of records) {
      const target = record.target;
      if (!(target instanceof Element)) continue;
      if (target.closest(SKIP)) continue;
      const settled = target.closest(ENTER);
      if (settled && seen.has(settled)) continue;
      for (const added of record.addedNodes) harvest(added, found);
    }
    queue(found);
  });

  observer.observe(root, { childList: true, subtree: true });
  return () => {
    if (frame) cancelAnimationFrame(frame);
    observer.disconnect();
  };
}

export function useDeskMotion(scope: RefObject<HTMLElement | null>) {
  useGSAP(
    () => {
      const root = scope.current;
      if (!root) return;
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const tl = gsap.timeline({ defaults: { ease: "power2.out" } });
        const nav = root.querySelector(".side-nav");
        const items = root.querySelectorAll(".nav-item");
        const bar = root.querySelector(".topbar");
        if (nav) tl.from(nav, { x: -18, autoAlpha: 0, duration: 0.5, clearProps: "opacity,visibility,transform" }, 0);
        if (items.length) {
          tl.from(items, { x: -10, autoAlpha: 0, duration: 0.32, stagger: 0.04, clearProps: "opacity,visibility,transform" }, 0.08);
        }
        if (bar) tl.from(bar, { y: -12, autoAlpha: 0, duration: 0.42, clearProps: "opacity,visibility,transform" }, 0.04);
        const main = root.querySelector(".shell-main");
        const stop = main ? watchEntrances(main) : () => {};
        return () => stop();
      });
      return () => mm.revert();
    },
    { scope },
  );
}

export function useSignInMotion(scope: RefObject<HTMLElement | null>) {
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(".signin-card", {
          autoAlpha: 0,
          y: 18,
          duration: 0.55,
          ease: "power2.out",
          clearProps: "opacity,visibility,transform",
        });
      });
      return () => mm.revert();
    },
    { scope },
  );
}

export function useThemeWipe(scope: RefObject<HTMLButtonElement | null>) {
  const busy = useRef(false);
  const veilRef = useRef<HTMLDivElement | null>(null);
  const pendingApply = useRef<(() => void) | null>(null);
  const expandTween = useRef<gsap.core.Tween | null>(null);
  const fadeTween = useRef<gsap.core.Tween | null>(null);

  useEffect(() => {
    return () => {
      const pending = pendingApply.current;
      const expand = expandTween.current;
      const fade = fadeTween.current;
      pendingApply.current = null;
      expandTween.current = null;
      fadeTween.current = null;
      expand?.eventCallback("onComplete", null);
      expand?.eventCallback("onInterrupt", null);
      fade?.eventCallback("onComplete", null);
      fade?.eventCallback("onInterrupt", null);
      expand?.kill();
      fade?.kill();
      veilRef.current?.remove();
      veilRef.current = null;
      busy.current = false;
      pending?.();
    };
  }, []);

  return (next: "light" | "dark", apply: () => void) => {
    const button = scope.current;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!button || reduce || busy.current) {
      if (!busy.current) apply();
      return;
    }
    busy.current = true;
    let applied = false;
    const applyOnce = () => {
      if (applied) return;
      applied = true;
      pendingApply.current = null;
      apply();
    };
    pendingApply.current = applyOnce;
    let fading = false;

    const rect = button.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
    const veil = document.createElement("div");
    veil.className = `theme-wipe theme-wipe-${next}`;
    veil.style.clipPath = `circle(0px at ${x}px ${y}px)`;
    document.body.appendChild(veil);
    veilRef.current = veil;

    const dropVeil = () => {
      fadeTween.current = null;
      if (veilRef.current === veil) veilRef.current = null;
      veil.remove();
      busy.current = false;
    };
    const fadeOut = () => {
      if (fading) return;
      fading = true;
      expandTween.current = null;
      applyOnce();
      fadeTween.current = gsap.to(veil, {
        autoAlpha: 0,
        duration: 0.2,
        onComplete: dropVeil,
        onInterrupt: dropVeil,
      });
    };

    const icon = button.querySelector("svg");
    if (icon) {
      gsap.fromTo(
        icon,
        { rotation: 0, scale: 0.8 },
        { rotation: next === "dark" ? 90 : -90, scale: 1, duration: 0.4, ease: "power2.out", clearProps: "transform" },
      );
    }
    expandTween.current = gsap.to(veil, {
      clipPath: `circle(${radius}px at ${x}px ${y}px)`,
      duration: 0.55,
      ease: "power2.inOut",
      onComplete: fadeOut,
      onInterrupt: fadeOut,
    });
  };
}
