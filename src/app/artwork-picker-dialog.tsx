"use client";

import { useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";

export type FocusableElement = HTMLElement | SVGElement;

export interface ArtworkPickerDialogProps {
  readonly title: string;
  readonly onClose: () => void;
  readonly restoreFocusRef: RefObject<FocusableElement | null>;
  readonly fallbackFocusRef?: RefObject<HTMLElement | null>;
  readonly children: ReactNode;
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(
    'button:not([tabindex="-1"]), a[href], input, select, textarea, summary, [tabindex="0"]',
  )).filter((element) => {
    if (element.hasAttribute("disabled") || element.closest("[hidden]") || element.closest("[inert]")) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

export default function ArtworkPickerDialog({ title, onClose, restoreFocusRef, fallbackFocusRef, children }: ArtworkPickerDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>("[data-picker-initial-focus]")?.focus();
    if (!dialog?.contains(document.activeElement)) dialog?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusables = focusableElements(dialog);
      if (focusables.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      const opener = restoreFocusRef.current;
      if (opener?.isConnected) opener.focus();
      else {
        const fallback = fallbackFocusRef?.current;
        if (fallback?.isConnected) fallback.focus();
      }
    };
  }, [onClose, restoreFocusRef, fallbackFocusRef]);

  return <>
    <div className="artwork-picker-backdrop" aria-hidden="true" />
    <dialog
      ref={dialogRef}
      className="artwork-picker-dialog"
      open
      role="dialog"
      aria-modal="true"
      aria-labelledby="artwork-picker-title"
      tabIndex={-1}
      data-testid="artwork-picker-dialog"
    >
      <header className="artwork-picker-heading">
        <h2 id="artwork-picker-title">{title}</h2>
        <button className="button secondary" type="button" aria-label="Fechar seletor de arte" onClick={onClose}>Fechar</button>
      </header>
      <div className="artwork-picker-dialog-content">{children}</div>
    </dialog>
  </>;
}
