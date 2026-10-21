import { AppWindow, Plus } from "lucide-react";

export function ActionBar({ onNewProperty, onNewBuilding, onWidget }: { onNewProperty: () => void; onNewBuilding: () => void; onWidget: () => void }) {
  return (
    <div className="hh-props-actions">
      <button type="button" className="button primary" onClick={onNewProperty} data-testid="button-new-property"><Plus size={14} /> New property</button>
      <button type="button" className="button" onClick={onNewBuilding} data-testid="button-new-building"><Plus size={14} /> New building</button>
      <button type="button" className="button" onClick={onWidget} data-testid="button-website-widget"><AppWindow size={14} /> Website widget</button>
    </div>
  );
}
