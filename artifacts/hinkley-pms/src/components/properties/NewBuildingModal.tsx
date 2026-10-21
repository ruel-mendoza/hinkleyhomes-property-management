import { useMemo, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Building2, Search } from "lucide-react";
import { getListPropertiesQueryKey, type BuildingSummary, type PropertySummary, useCreateBuilding } from "@workspace/api-client-react";
import { compareByStreet, locationLine, normaliseUkPostcode } from "@/services/properties";
import { errorText } from "@/components/action-modals";
import { ModalShell } from "./ModalShell";

export function NewBuildingModal({ properties, onClose, onSaved }: { properties: PropertySummary[]; onClose: () => void; onSaved: (building: BuildingSummary) => void }) {
  const queryClient = useQueryClient();
  const createBuilding = useCreateBuilding();
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [errors, setErrors] = useState<{ name?: string; postcode?: string }>({});
  const [formError, setFormError] = useState("");
  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase();
    return [...properties].sort(compareByStreet).filter((p) => !term || `${p.name} ${p.postcode ?? ""}`.toLowerCase().includes(term));
  }, [properties, filter]);
  const toggle = (id: string) => setSelected((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError("");
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const postcodeInput = text("postcode");
    const postcode = postcodeInput ? normaliseUkPostcode(postcodeInput) : null;
    const next = { name: text("name") ? undefined : "Give the building a name.", postcode: postcodeInput && !postcode ? "Enter a valid UK postcode, e.g. TA6 4AX." : undefined };
    setErrors(next);
    if (next.name || next.postcode) return;
    try {
      const saved = await createBuilding.mutateAsync({ data: { name: text("name"), addressLine1: text("addressLine1") || null, postcode, propertyIds: selected } });
      await queryClient.invalidateQueries({ queryKey: getListPropertiesQueryKey() });
      onSaved(saved);
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  return (
    <ModalShell
      title="New building"
      caption="Groups properties together, e.g. flats in one block. Saved in Supabase."
      onClose={onClose}
      onSubmit={submit}
      testId="form-new-building"
      footer={<>
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={createBuilding.isPending}><Building2 size={14} /> {createBuilding.isPending ? "Saving…" : "Save building"}</button>
      </>}
    >
      <div className="form-grid">
        <div className="field full">
          <label htmlFor="nb-name">Building name</label>
          <input id="nb-name" name="name" maxLength={120} autoComplete="off" aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? "nb-name-error" : undefined} />
          {errors.name && <small className="hh-field-error" id="nb-name-error">{errors.name}</small>}
        </div>
        <div className="field"><label htmlFor="nb-address">Address (optional)</label><input id="nb-address" name="addressLine1" maxLength={200} autoComplete="off" /></div>
        <div className="field">
          <label htmlFor="nb-postcode">Postcode (optional)</label>
          <input id="nb-postcode" name="postcode" maxLength={9} autoComplete="off" style={{ textTransform: "uppercase" }} aria-invalid={Boolean(errors.postcode)} aria-describedby={errors.postcode ? "nb-postcode-error" : undefined} />
          {errors.postcode && <small className="hh-field-error" id="nb-postcode-error">{errors.postcode}</small>}
        </div>
        <fieldset className="field full hh-pick">
          <legend>Properties in this building <span className="secondary-text" style={{ display: "inline", margin: 0 }}>{selected.length} selected</span></legend>
          <div className="hh-search"><Search size={13} aria-hidden="true" /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter properties…" aria-label="Filter properties" /></div>
          <div className="hh-pick-list">
            {visible.map((property) => (
              <label key={property.id}>
                <input type="checkbox" checked={selected.includes(property.id)} onChange={() => toggle(property.id)} />
                <span>{property.name}<small>{locationLine(property)}{property.buildings.length ? ` · in ${property.buildings.join(", ")}` : ""}</small></span>
              </label>
            ))}
            {!visible.length && <p className="hh-act-hint">No properties match.</p>}
          </div>
        </fieldset>
      </div>
      {formError && <p className="status overdue" role="alert">{formError}</p>}
    </ModalShell>
  );
}
