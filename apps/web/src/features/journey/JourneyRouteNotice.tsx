export function JourneyRouteNotice({
  eyebrow,
  title,
  detail,
  action,
  onAction,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly detail?: string;
  readonly action: string;
  readonly onAction: () => void;
}) {
  return (
    <main className="journey-route-notice">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      {detail === undefined ? null : <p>{detail}</p>}
      <button type="button" onClick={onAction}>
        {action}
      </button>
    </main>
  );
}
