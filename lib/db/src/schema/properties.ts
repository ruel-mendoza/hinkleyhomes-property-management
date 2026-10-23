import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { id, timestamps } from "./columns";

// The six Hinkley Homes Group companies. Single-tenant: there is no
// organisation table — every property belongs to one of these entities.
export const entitiesTable = pgTable("entities", {
  id: id(),
  name: text("name").notNull().unique(),
  legalName: text("legal_name"),
  companyNumber: text("company_number").unique(),
  xeroTenantId: text("xero_tenant_id").unique(),
  ...timestamps,
}).enableRLS();

// How a company's name is written on supplier invoices ("EDJ Investments Ltd",
// "Hinckley Homes") and the Xero organisation it means. Bill coding uses it to
// check who an invoice is addressed to.
export const companyAliasesTable = pgTable("company_aliases", {
  id: id(),
  alias: text("alias").notNull(),
  // Lower case, "&" as "and", Ltd / Limited / PLC dropped, words joined by single spaces.
  normalizedAlias: text("normalized_alias").notNull().unique(),
  xeroTenantId: text("xero_tenant_id").notNull(),
  notes: text("notes"),
  createdBy: text("created_by"),
  ...timestamps,
}).enableRLS();

export const propertyTypeEnum = pgEnum("property_type", [
  "hmo",
  "short_stay",
  "mixed",
  "single_let",
]);

export const recordStatusEnum = pgEnum("record_status", ["active", "archived"]);

// Master property register: one row per canonical address.
export const propertiesTable = pgTable(
  "properties",
  {
    id: id(),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entitiesTable.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    addressLine1: text("address_line_1").notNull(),
    addressLine2: text("address_line_2"),
    city: text("city"),
    postcode: text("postcode").notNull(),
    propertyType: propertyTypeEnum("property_type").notNull(),
    status: recordStatusEnum("status").notNull().default("active"),
    cohoPropertyReference: text("coho_property_reference").unique(),
    smoobuPropertyId: text("smoobu_property_id").unique(),
    // Set when staff add a property in this app before it exists in COHO.
    houseNumber: text("house_number"),
    streetName: text("street_name"),
    totalRooms: integer("total_rooms").notNull().default(1),
    imageUrl: text("image_url"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    ...timestamps,
  },
  (t) => [index("properties_entity_id_idx").on(t.entityId)],
).enableRLS();

// A group of properties (e.g. flats in one block). Members can be COHO
// properties (by reference) or register-only properties.
export const buildingsTable = pgTable("buildings", {
  id: id(),
  name: text("name").notNull(),
  addressLine1: text("address_line_1"),
  postcode: text("postcode"),
  ...timestamps,
}).enableRLS();

export const buildingPropertiesTable = pgTable(
  "building_properties",
  {
    id: id(),
    buildingId: uuid("building_id")
      .notNull()
      .references(() => buildingsTable.id, { onDelete: "cascade" }),
    propertyId: uuid("property_id").references(() => propertiesTable.id, { onDelete: "cascade" }),
    cohoPropertyReference: text("coho_property_reference"),
    ...timestamps,
  },
  (t) => [
    index("building_properties_building_id_idx").on(t.buildingId),
    index("building_properties_property_id_idx").on(t.propertyId).where(sql`${t.propertyId} is not null`),
    uniqueIndex("building_properties_property_uq").on(t.buildingId, t.propertyId).where(sql`${t.propertyId} is not null`),
    uniqueIndex("building_properties_coho_uq").on(t.buildingId, t.cohoPropertyReference).where(sql`${t.cohoPropertyReference} is not null`),
    check("building_properties_one_target", sql`(${t.propertyId} is null) <> (${t.cohoPropertyReference} is null)`),
  ],
).enableRLS();

// Lettable rooms / units inside a property (HMO rooms or short-stay apartments).
export const roomsTable = pgTable(
  "rooms",
  {
    id: id(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => propertiesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: recordStatusEnum("status").notNull().default("active"),
    cohoRoomReference: text("coho_room_reference").unique(),
    smoobuApartmentId: text("smoobu_apartment_id").unique(),
    ...timestamps,
  },
  (t) => [uniqueIndex("rooms_property_name_uq").on(t.propertyId, t.name)],
).enableRLS();

export const aliasSourceEnum = pgEnum("alias_source", [
  "manual",
  "coho",
  "smoobu",
  "xero",
  "email",
  "invoice",
]);

// text: a spelling of a property ("51 Bridgwater Rd"); line: a staff answer
// for one line of one supplier bill (bill coding), keyed by bill and line.
export const aliasKindEnum = pgEnum("alias_kind", ["text", "line"]);

// Every spelling seen in the wild ("51 Bridgwater Rd", "51 A", ...) mapped to
// its canonical property (and optionally a room), or to a Xero company and its
// Property tracking option (used to code supplier bills). xeroTrackingOption
// null with overhead true = a company cost with no property.
export const propertyAliasesTable = pgTable(
  "property_aliases",
  {
    id: id(),
    propertyId: uuid("property_id").references(() => propertiesTable.id, { onDelete: "cascade" }),
    roomId: uuid("room_id").references(() => roomsTable.id, { onDelete: "cascade" }),
    kind: aliasKindEnum("kind").notNull().default("text"),
    alias: text("alias").notNull(),
    // Matching form: lower case, common abbreviations expanded (rd -> road),
    // street-type words dropped, words joined by single spaces. Line answers
    // keep their bill-and-line key.
    normalizedAlias: text("normalized_alias").notNull(),
    xeroTenantId: text("xero_tenant_id"),
    xeroTrackingOption: text("xero_tracking_option"),
    overhead: boolean("overhead").notNull().default(false),
    source: aliasSourceEnum("source").notNull().default("manual"),
    verified: boolean("verified").notNull().default(false),
    createdBy: text("created_by"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("property_aliases_normalized_uq").on(t.normalizedAlias),
    index("property_aliases_property_id_idx").on(t.propertyId),
    index("property_aliases_room_id_idx").on(t.roomId).where(sql`${t.roomId} is not null`),
    check("property_aliases_has_target", sql`${t.propertyId} is not null or ${t.xeroTenantId} is not null`),
  ],
).enableRLS();

export const insertEntitySchema = createInsertSchema(entitiesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPropertySchema = createInsertSchema(propertiesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertRoomSchema = createInsertSchema(roomsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPropertyAliasSchema = createInsertSchema(propertyAliasesTable).omit({ id: true, createdAt: true, updatedAt: true });

export type Entity = typeof entitiesTable.$inferSelect;
export type InsertEntity = z.infer<typeof insertEntitySchema>;
export type Property = typeof propertiesTable.$inferSelect;
export type InsertProperty = z.infer<typeof insertPropertySchema>;
export type Room = typeof roomsTable.$inferSelect;
export type InsertRoom = z.infer<typeof insertRoomSchema>;
export type Building = typeof buildingsTable.$inferSelect;
export type PropertyAlias = typeof propertyAliasesTable.$inferSelect;
export type InsertPropertyAlias = z.infer<typeof insertPropertyAliasSchema>;
