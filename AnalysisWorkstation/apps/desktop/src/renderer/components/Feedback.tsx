import { WarningCircle } from "@phosphor-icons/react";

export function InlineError({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="inline-error" role="alert">
      <WarningCircle size={18} weight="fill" />
      <span>{message}</span>
    </div>
  );
}

export function LoadingRows({ count = 4 }: { count?: number }): React.JSX.Element {
  return (
    <div className="skeleton-list" aria-label="正在加载" aria-busy="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="skeleton-row" key={index}>
          <span className="skeleton-block skeleton-block--title" />
          <span className="skeleton-block skeleton-block--line" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      {description === undefined ? null : <p>{description}</p>}
      {action === undefined ? null : <div className="empty-state__action">{action}</div>}
    </div>
  );
}
