import { cohoGet } from "./coho-api";

// Every active COHO property, for the Properties page and for matching Smoobu
// apartments to the property they are in.

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as RecordValue) : {};
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const int = (value: unknown): number => (Number.isInteger(value) ? (value as number) : 0);

export type CohoPropertyRow = {
  reference: string;
  publicReference: string | null;
  name: string;
  houseNumber: string | null;
  streetName: string | null;
  postcode: string | null;
  town: string | null;
  imageUrl: string | null;
  tags: string[];
  totalRooms: number;
  roomsOccupied: number;
  rentalType: "room" | "whole_property";
  propertyType: string | null;
};

// COHO lists only active properties; pages of 100 cover the whole portfolio.
export async function fetchCohoProperties(): Promise<CohoPropertyRow[]> {
  const rows: CohoPropertyRow[] = [];
  for (let page = 1; page <= 20; page++) {
    const payload = asRecord(await cohoGet(`/properties?page=${page}&pageSize=100`));
    for (const item of Array.isArray(payload.items) ? payload.items.map(asRecord) : []) {
      const reference = str(item.reference);
      if (!reference) continue;
      const address = asRecord(item.address);
      rows.push({
        reference,
        publicReference: str(item.publicReference),
        name: str(item.name) ?? reference,
        houseNumber: str(item.houseNumber),
        streetName: str(item.streetName),
        postcode: str(item.postcode),
        town: str(address.city) ?? str(address.district),
        imageUrl: str(asRecord(item.image).url),
        tags: Array.isArray(item.tagStrings) ? item.tagStrings.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "") : [],
        totalRooms: Math.max(int(item.totalRooms), 1),
        roomsOccupied: int(item.roomsOccupied),
        // COHO "multi" = let by the room (HMO); anything else is let as a whole.
        rentalType: item.rentalType === "multi" ? "room" : "whole_property",
        propertyType: str(item.propertyType),
      });
    }
    if (payload.hasNextPage !== true) return rows;
  }
  return rows;
}
