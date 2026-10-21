import { sql } from "drizzle-orm";
import { boolean, index, pgEnum, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
    ...timestamps,
  },
  (t) => [index("properties_entity_id_idx").on(t.entityId)],
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

// Every spelling seen in the wild ("51 Bridgwater Rd", "51 A", ...) mapped to
// its canonical property, and optionally to a specific room.
export const propertyAliasesTable = pgTable(
  "property_aliases",
  {
    id: id(),
    propertyId: uuid("property_id")
      .notNull()
      .references(() => propertiesTable.id, { onDelete: "cascade" }),
    roomId: uuid("room_id").references(() => roomsTable.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    // Lower-cased, punctuation-stripped, whitespace-collapsed form used for matching.
    normalizedAlias: text("normalized_alias").notNull(),
    source: aliasSourceEnum("source").notNull().default("manual"),
    verified: boolean("verified").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("property_aliases_normalized_uq").on(t.normalizedAlias),
    index("property_aliases_property_id_idx").on(t.propertyId),
    index("property_aliases_room_id_idx").on(t.roomId).where(sql`${t.roomId} is not null`),
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
export type PropertyAlias = typeof propertyAliasesTable.$inferSelect;
export type InsertPropertyAlias = z.infer<typeof insertPropertyAliasSchema>;
