import { useId } from "react";
import { errorCls, inputCls, mutedCls } from "./styles";

type Common = { label: string; error?: string; hint?: string };

function describedBy(id: string, error?: string, hint?: string) {
  const ids = [hint && `${id}-hint`, error && `${id}-err`].filter(Boolean);
  return ids.length ? ids.join(" ") : undefined;
}

function Wrap({
  id,
  label,
  error,
  hint,
  children,
}: Common & { id: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className={`text-sm ${mutedCls}`}>
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-err`} className={errorCls}>
          {error}
        </p>
      )}
    </div>
  );
}

export function TextField({
  label,
  error,
  hint,
  className,
  ...rest
}: Common & React.InputHTMLAttributes<HTMLInputElement>) {
  const auto = useId();
  const id = rest.id ?? auto;
  return (
    <Wrap id={id} label={label} error={error} hint={hint}>
      <input
        {...rest}
        id={id}
        className={`${inputCls} ${className ?? ""}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
      />
    </Wrap>
  );
}

export function TextAreaField({
  label,
  error,
  hint,
  ...rest
}: Common & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const auto = useId();
  const id = rest.id ?? auto;
  return (
    <Wrap id={id} label={label} error={error} hint={hint}>
      <textarea
        rows={3}
        {...rest}
        id={id}
        className={inputCls}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
      />
    </Wrap>
  );
}

export function SelectField({
  label,
  error,
  hint,
  children,
  ...rest
}: Common & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const auto = useId();
  const id = rest.id ?? auto;
  return (
    <Wrap id={id} label={label} error={error} hint={hint}>
      <select
        {...rest}
        id={id}
        className={inputCls}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
      >
        {children}
      </select>
    </Wrap>
  );
}

export function CheckboxField({
  label,
  ...rest
}: { label: string } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">) {
  return (
    <label className="flex min-h-11 items-center gap-3 text-sm">
      <input type="checkbox" {...rest} className="size-5 accent-blue-700" />
      {label}
    </label>
  );
}
