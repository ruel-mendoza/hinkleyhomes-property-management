import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, X } from "lucide-react";
import {
  getListCohoCalendarQueryKey,
  type CohoProperty,
  type CohoViewingInput,
  useCreateCohoViewing,
} from "@workspace/api-client-react";

type BookViewingModalProps = {
  properties: CohoProperty[];
  initialPropertyReference?: string;
  // yyyy-mm-dd, local
  initialDate: string;
  onClose: () => void;
  onBooked: (message: string) => void;
};

const DURATIONS = [15, 30, 45, 60, 90];

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = error as { message?: unknown; data?: { error?: unknown } };
    if (typeof candidate.data?.error === "string") return candidate.data.error;
    if (typeof candidate.message === "string") return candidate.message;
  }
  return "The viewing could not be booked. Please try again.";
}

export function BookViewingModal({ properties, initialPropertyReference, initialDate, onClose, onBooked }: BookViewingModalProps) {
  const queryClient = useQueryClient();
  const createViewing = useCreateCohoViewing();
  const [propertyReference, setPropertyReference] = useState(initialPropertyReference ?? "");
  const [proposeTime, setProposeTime] = useState(true);
  const [formError, setFormError] = useState("");
  const property = properties.find((item) => item.reference === propertyReference);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError("");
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) || "").trim();
    let proposedDate: Date | null = null;
    if (proposeTime) {
      proposedDate = new Date(`${text("date")}T${text("time")}`);
      if (Number.isNaN(proposedDate.getTime())) {
        setFormError("Enter a valid date and time for the viewing.");
        return;
      }
      if (proposedDate.getTime() < Date.now()) {
        setFormError("The viewing time is in the past.");
        return;
      }
    }
    const data: CohoViewingInput = {
      propertyReference,
      roomReference: text("roomReference") || null,
      forename: text("forename"),
      surname: text("surname"),
      emailAddress: text("emailAddress"),
      mobileNumber: text("mobileNumber") || null,
      proposedDate: proposedDate ? proposedDate.toISOString() : null,
      proposedDuration: proposedDate ? Number(text("duration")) : null,
      requestMessage: text("requestMessage"),
    };
    try {
      const created = await createViewing.mutateAsync({ data });
      await queryClient.invalidateQueries({ queryKey: getListCohoCalendarQueryKey() });
      const who = `${data.forename} ${data.surname}`;
      onBooked(`Viewing ${created.reference ? `${created.reference} ` : ""}booked in COHO for ${who}${property?.name ? ` at ${property.name}` : ""}.`);
    } catch (error) {
      setFormError(errorMessage(error));
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form className="modal" onSubmit={submit} data-testid="form-book-viewing">
        <div className="modal-head">
          <div>
            <h2>Book a viewing</h2>
            <div className="panel-caption">Creates the viewing in COHO. COHO notifies the property manager and may text the applicant.</div>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><X size={17} /></button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <div className="field full">
              <label htmlFor="viewing-property">Property</label>
              <select id="viewing-property" required value={propertyReference} onChange={(event) => setPropertyReference(event.target.value)}>
                <option value="" disabled>Select a COHO property</option>
                {properties.map((item) => <option key={item.reference ?? item.name} value={item.reference ?? ""} disabled={!item.reference}>{item.name || item.reference || "Unnamed property"}</option>)}
              </select>
            </div>
            <div className="field full">
              <label htmlFor="viewing-room">Room (optional)</label>
              <select key={propertyReference} id="viewing-room" name="roomReference" defaultValue="">
                <option value="">Whole property / any room</option>
                {(property?.rooms ?? []).map((room) => <option key={room.reference ?? room.name} value={room.reference ?? ""} disabled={!room.reference}>{room.name || room.reference || "Unnamed room"}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="viewing-forename">First name</label>
              <input id="viewing-forename" name="forename" required maxLength={100} autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="viewing-surname">Last name</label>
              <input id="viewing-surname" name="surname" required maxLength={100} autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="viewing-email">Email</label>
              <input id="viewing-email" name="emailAddress" type="email" required autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="viewing-mobile">Mobile (optional)</label>
              <input id="viewing-mobile" name="mobileNumber" type="tel" maxLength={30} placeholder="+44" autoComplete="off" />
            </div>
            <div className="field full">
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 600 }}>
                <input type="checkbox" checked={proposeTime} onChange={(event) => setProposeTime(event.target.checked)} /> Propose a date and time
              </label>
            </div>
            {proposeTime && <>
              <div className="field">
                <label htmlFor="viewing-date">Date</label>
                <input id="viewing-date" name="date" type="date" required defaultValue={initialDate} />
              </div>
              <div className="field">
                <label htmlFor="viewing-time">Time</label>
                <input id="viewing-time" name="time" type="time" required defaultValue="10:00" step={900} />
              </div>
              <div className="field">
                <label htmlFor="viewing-duration">Length</label>
                <select id="viewing-duration" name="duration" defaultValue="30">
                  {DURATIONS.map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes</option>)}
                </select>
              </div>
            </>}
            <div className="field full">
              <label htmlFor="viewing-message">Notes for the property manager</label>
              <textarea id="viewing-message" name="requestMessage" rows={3} required maxLength={2000} placeholder="e.g. Interested in a room from November; works locally." />
            </div>
          </div>
          {formError && <p className="status overdue" role="alert">{formError}</p>}
          <div className="modal-actions">
            <button type="button" className="button" onClick={onClose}>Cancel</button>
            <button type="submit" className="button primary" disabled={createViewing.isPending || !propertyReference}>
              <CalendarPlus size={14} /> {createViewing.isPending ? "Booking…" : "Book viewing"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
