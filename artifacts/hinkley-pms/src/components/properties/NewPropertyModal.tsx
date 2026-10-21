import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import {
  getListPropertiesQueryKey,
  type PropertyRentalType,
  type PropertySummary,
  useCreateProperty,
  useListEntities,
} from "@workspace/api-client-react";
import { normaliseUkPostcode } from "@/services/properties";
import { errorText } from "@/components/action-modals";
import { ModalShell } from "./ModalShell";
import { TagCombobox } from "./TagCombobox";

type Errors = Partial<Record<"entityId" | "streetName" | "town" | "postcode" | "totalRooms" | "imageUrl", string>>;

export function NewPropertyModal({ tagOptions, onClose, onSaved }: { tagOptions: string[]; onClose: () => void; onSaved: (property: PropertySummary) => void }) {
  const queryClient = useQueryClient();
  const entitiesQuery = useListEntities();
  const createProperty = useCreateProperty();
  const [rentalType, setRentalType] = useState<PropertyRentalType>("room");
  const [tags, setTags] = useState<string[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState("");
  const entities = entitiesQuery.data?.items ?? [];

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError("");
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? "").trim();
    const postcode = normaliseUkPostcode(text("postcode"));
    const totalRooms = Number(text("totalRooms"));
    const imageUrl = text("imageUrl");
    const next: Errors = {};
    if (!text("entityId")) next.entityId = "Choose the company that owns it.";
    if (!text("streetName")) next.streetName = "Enter the street name.";
    if (!text("town")) next.town = "Enter the town.";
    if (!postcode) next.postcode = "Enter a valid UK postcode, e.g. TA6 4AX.";
    if (!Number.isInteger(totalRooms) || totalRooms < 1 || totalRooms > 50) next.totalRooms = "Enter a whole number from 1 to 50.";
    if (imageUrl && !/^https:\/\/\S+$/i.test(imageUrl)) next.imageUrl = "Use a link that starts with https://.";
    setErrors(next);
    if (Object.keys(next).length) return;
    try {
      const saved = await createProperty.mutateAsync({
        data: {
          entityId: text("entityId"),
          houseNumber: text("houseNumber") || null,
          streetName: text("streetName"),
          town: text("town"),
          postcode: postcode!,
          rentalType,
          totalRooms,
          tags,
          imageUrl: imageUrl || null,
        },
      });
      await queryClient.invalidateQueries({ queryKey: getListPropertiesQueryKey() });
      onSaved(saved);
    } catch (error) {
      setFormError(errorText(error));
    }
  };
  const fieldError = (name: keyof Errors) => errors[name] && <small className="hh-field-error" id={`np-${name}-error`}>{errors[name]}</small>;
  const describedBy = (name: keyof Errors) => (errors[name] ? `np-${name}-error` : undefined);

  return (
    <ModalShell
      title="New property"
      caption="Saved to the Hinkley Homes property register in Supabase. COHO's API can't create properties, so add it in COHO too."
      onClose={onClose}
      onSubmit={submit}
      testId="form-new-property"
      footer={<>
        <button type="button" className="button" onClick={onClose}>Cancel</button>
        <button type="submit" className="button primary" disabled={createProperty.isPending}><Plus size={14} /> {createProperty.isPending ? "Saving…" : "Save property"}</button>
      </>}
    >
      <div className="form-grid">
        <div className="field full">
          <label htmlFor="np-entity">Company</label>
          <select id="np-entity" name="entityId" defaultValue="" aria-invalid={Boolean(errors.entityId)} aria-describedby={describedBy("entityId")}>
            <option value="" disabled>{entitiesQuery.isLoading ? "Loading…" : "Choose a Hinkley Homes company"}</option>
            {entities.map((entity) => <option key={entity.id} value={entity.id}>{entity.name}</option>)}
          </select>
          {fieldError("entityId")}
        </div>
        <div className="field"><label htmlFor="np-house">House number or name</label><input id="np-house" name="houseNumber" maxLength={40} autoComplete="off" placeholder="e.g. 127" /></div>
        <div className="field">
          <label htmlFor="np-street">Street name</label>
          <input id="np-street" name="streetName" maxLength={120} autoComplete="off" placeholder="e.g. Bristol Road" aria-invalid={Boolean(errors.streetName)} aria-describedby={describedBy("streetName")} />
          {fieldError("streetName")}
        </div>
        <div className="field">
          <label htmlFor="np-town">Town</label>
          <input id="np-town" name="town" maxLength={80} defaultValue="Bridgwater" aria-invalid={Boolean(errors.town)} aria-describedby={describedBy("town")} />
          {fieldError("town")}
        </div>
        <div className="field">
          <label htmlFor="np-postcode">Postcode</label>
          <input id="np-postcode" name="postcode" maxLength={9} autoComplete="off" placeholder="TA6 4AX" style={{ textTransform: "uppercase" }} aria-invalid={Boolean(errors.postcode)} aria-describedby={describedBy("postcode")} />
          {fieldError("postcode")}
        </div>
        <fieldset className="field full hh-radio-row">
          <legend>Rental type</legend>
          <label><input type="radio" name="rentalType" checked={rentalType === "room"} onChange={() => setRentalType("room")} /> Let by the room</label>
          <label><input type="radio" name="rentalType" checked={rentalType === "whole_property"} onChange={() => setRentalType("whole_property")} /> Whole property</label>
        </fieldset>
        <div className="field">
          <label htmlFor="np-rooms">Total rooms</label>
          <input id="np-rooms" name="totalRooms" type="number" min={1} max={50} step={1} defaultValue={rentalType === "room" ? 5 : 1} key={rentalType} aria-invalid={Boolean(errors.totalRooms)} aria-describedby={describedBy("totalRooms")} />
          {fieldError("totalRooms")}
        </div>
        <div className="field">
          <label htmlFor="np-image">Image URL (optional)</label>
          <input id="np-image" name="imageUrl" type="url" maxLength={500} placeholder="https://…" aria-invalid={Boolean(errors.imageUrl)} aria-describedby={describedBy("imageUrl")} />
          {fieldError("imageUrl")}
        </div>
        <div className="field full">
          <span className="hh-label">Tags (optional)</span>
          <TagCombobox value={tags} options={[...new Set([...tagOptions, "HMO", "Students", "Professionals", "Bills included"])]} onChange={setTags} placeholder="Add tags…" allowNew label="Tags" />
        </div>
      </div>
      {formError && <p className="status overdue" role="alert">{formError}</p>}
    </ModalShell>
  );
}
