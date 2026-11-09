import { useCallback, useEffect, useRef, useState } from "react";
import { DESK_NOTICE_KEY } from "./auth.js";

/** Phones in portrait, and phones turned sideways. */
export const PHONE_LAYOUT_QUERY = "(max-width: 840px), (max-height: 500px) and (max-width: 960px)";

const COPY = {
  tower: {
    title: "Control Tower is clearer on a larger screen",
    body: "Dispatch, the live map, and analytics sit side by side on a computer or laptop. On a phone those boards stack, and wide tables scroll sideways. You can keep working here if you need to.",
  },
  gate: {
    title: "The yard desk is clearer on a larger screen",
    body: "Check-in, the yard map, and dock assignment are easier to see on a computer or laptop. On a phone the queue and the map stack. You can keep working here if a truck is at the gate.",
  },
  warehouse: {
    title: "The floor desk is clearer on a larger screen",
    body: "Receive, pick, and load are laid out for a terminal, a laptop, or a desk. On a phone the steps stack. You can keep working here if you need to.",
  },
} as const;

export type DeskNoticeId = keyof typeof COPY;

export function usePhoneLayout() {
  const query = PHONE_LAYOUT_QUERY;
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return matches;
}

export function DeskNotice({ desk }: { desk: DeskNoticeId }) {
  const phone = usePhoneLayout();
  const [staying, setStaying] = useState(() => sessionStorage.getItem(DESK_NOTICE_KEY) === "1");
  const continueRef = useRef<HTMLButtonElement>(null);
  const open = phone && !staying;
  const stay = useCallback(() => {
    sessionStorage.setItem(DESK_NOTICE_KEY, "1");
    setStaying(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    continueRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") stay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, stay]);

  if (!open) return null;
  const copy = COPY[desk];

  return (
    <div className="modal-backdrop desk-notice-backdrop" onMouseDown={stay}>
      <div
        className="modal desk-notice"
        role="dialog"
        aria-modal="true"
        aria-labelledby="desk-notice-title"
        aria-describedby="desk-notice-body"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="desk-notice-title">{copy.title}</h2>
        <p id="desk-notice-body">{copy.body}</p>
        <div className="desk-notice-actions">
          <button ref={continueRef} type="button" className="btn btn-primary" onClick={stay}>
            Continue on this phone
          </button>
        </div>
      </div>
    </div>
  );
}
