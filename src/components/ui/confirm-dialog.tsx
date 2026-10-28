"use client";

import { useEffect, useId, useRef } from "react";
import { btnDanger, btnSecondary } from "./styles";

type Props = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  confirmDisabled?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
};

/** Modal built on the native <dialog>: focus trap and Escape come for free. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  confirmDisabled,
  pending,
  onConfirm,
  onCancel,
  children,
}: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      aria-labelledby={titleId}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-[14px] border border-line-strong bg-card p-5 text-ink backdrop:bg-black/50"
    >
      <h2 id={titleId} className="text-lg font-semibold">
        {title}
      </h2>
      <p className="mt-2 text-sm">{description}</p>
      <div className="mt-4 flex flex-col gap-3">{children}</div>
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" className={btnSecondary} onClick={onCancel}>
          {cancelLabel}
        </button>
        <button
          type="button"
          className={btnDanger}
          disabled={confirmDisabled || pending}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
