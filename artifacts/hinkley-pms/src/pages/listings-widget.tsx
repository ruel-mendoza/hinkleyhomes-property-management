import { BedDouble, House } from "lucide-react";
import { getListPublicListingsQueryKey, useListPublicListings } from "@workspace/api-client-react";
import "./properties/properties.css";

// Public page embedded on the Hinkley Homes website through an <iframe>.
// No sign-in; shows only advert-level details from /api/public/listings.
export default function ListingsWidget() {
  const query = useListPublicListings({ query: { queryKey: getListPublicListingsQueryKey(), refetchInterval: 300_000 } });
  const items = query.data?.items ?? [];
  return (
    <main className="hh-widget">
      <h1>Available now</h1>
      {query.isLoading && <p className="hh-widget-note">Loading available properties…</p>}
      {query.isError && <p className="hh-widget-note">Availability can't be shown right now. Please contact us.</p>}
      {query.isSuccess && !items.length && <p className="hh-widget-note">Everything is let at the moment. Please check back soon.</p>}
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            {item.imageUrl ? <img src={item.imageUrl} alt="" loading="lazy" /> : <span className="hh-widget-noimg" aria-hidden="true"><House size={28} /></span>}
            <div>
              <strong>{item.title}</strong>
              <span>{[item.town, item.postcodeArea].filter(Boolean).join(" · ")}</span>
              <span className="hh-widget-rooms">
                <BedDouble size={13} aria-hidden="true" />
                {item.rentalType === "whole_property" ? "Whole property available" : `${item.roomsAvailable} of ${item.totalRooms} ${item.totalRooms === 1 ? "room" : "rooms"} available`}
              </span>
            </div>
          </li>
        ))}
      </ul>
      <p className="hh-widget-brand">Hinkley Homes</p>
    </main>
  );
}
