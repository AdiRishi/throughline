import { ArrowLeft, GearSix } from "@phosphor-icons/react";

export function WindowControls() {
  return (
    <span className="window-controls" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

export function BackButton({ onClick }: { readonly onClick: () => void }) {
  return (
    <button className="chrome-back" onClick={onClick}>
      <ArrowLeft size={13} weight="bold" />
      Back
    </button>
  );
}

export function SettingsGlyph() {
  return <GearSix size={14} weight="bold" aria-hidden />;
}
