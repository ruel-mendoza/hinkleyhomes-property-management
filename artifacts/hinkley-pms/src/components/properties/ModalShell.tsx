import { useEffect, useId, type FormEventHandler, type ReactNode } from "react";
import { X } from "lucide-react";

type ModalShellProps = {
  title: string;
  caption?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  onSubmit?: FormEventHandler<HTMLFormElement>;
  wide?: boolean;
  testId?: string;
};

// Same look as the app's other modals; a form when onSubmit is given.
export function ModalShell({ title, caption, onClose, children, footer, onSubmit, wide, testId }: ModalShellProps) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const content = (
    <>
      <div className="modal-head">
        <div>
          <h2 id={titleId}>{title}</h2>
          {caption && <div className="panel-caption">{caption}</div>}
        </div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><X size={17} /></button>
      </div>
      <div className="modal-body">
        {children}
        {footer && <div className="modal-actions">{footer}</div>}
      </div>
    </>
  );
  const className = `modal ${wide ? "hh-act-modal" : ""}`;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      {onSubmit
        ? <form className={className} role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={onSubmit} noValidate data-testid={testId}>{content}</form>
        : <div className={className} role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId}>{content}</div>}
    </div>
  );
}
