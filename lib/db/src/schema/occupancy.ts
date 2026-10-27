import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { id, money, timestamps } from "./columns";
import { propertiesTable, roomsTable } from "./properties";

export const tenantsTable = pgTable("tenants", {
  id: id(),
  fullName: text("full_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  cohoPersonReference: text("coho_person_reference").unique(),
  ...timestamps,
}).enableRLS();

export const tenancyStatusEnum = pgEnum("tenancy_status", [
  "pending",
  "active",
  "notice_given",
  "ended",
  "cancelled",
]);

export const rentFrequencyEnum = pgEnum("rent_frequency", ["weekly", "monthly"]);

// Long-term HMO tenancies, synced from COHO.
export const tenanciesTable = pgTable(
  "tenancies",
  {
    id: id(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => roomsTable.id, { onDelete: "restrict" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "restrict" }),
    cohoTenancyReference: text("coho_tenancy_reference").unique(),
    status: tenancyStatusEnum("status").notNull().default("pending"),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    rentAmount: money("rent_amount").notNull(),
    rentFrequency: rentFrequencyEnum("rent_frequency").notNull().default("monthly"),
    depositAmount: money("deposit_amount"),
    ...timestamps,
  },
  (t) => [
    index("tenancies_room_id_idx").on(t.roomId),
    index("tenancies_tenant_id_idx").on(t.tenantId),
    check("tenancies_dates_chk", sql`${t.endDate} is null or ${t.endDate} >= ${t.startDate}`),
  ],
).enableRLS();

export const bookingStatusEnum = pgEnum("booking_status", [
  "confirmed",
  "checked_in",
  "checked_out",
  "cancelled",
]);

// Smoobu apartments (Hinkley Homes Stays). A register property is linked to
// one by properties.smoobu_property_id; most short-stay apartments are only here.
export const smoobuApartmentsTable = pgTable("smoobu_apartments", {
  id: id(),
  smoobuApartmentId: integer("smoobu_apartment_id").notNull().unique(),
  name: text("name").notNull(),
  street: text("street"),
  city: text("city"),
  postcode: text("postcode"),
  maxOccupancy: integer("max_occupancy"),
  bedrooms: integer("bedrooms"),
  ...timestamps,
}).enableRLS();

// Short-stay bookings, synced read-only from Smoobu (the source of truth for
// serviced accommodation; PriceLabs and the OTAs connect to it). Blocked dates
// are not stored. Only the guest's name is kept, never contact details.
export const shortStayBookingsTable = pgTable(
  "short_stay_bookings",
  {
    id: id(),
    // Set when the Smoobu apartment is linked to a register property.
    propertyId: uuid("property_id").references(() => propertiesTable.id, { onDelete: "set null" }),
    roomId: uuid("room_id").references(() => roomsTable.id, { onDelete: "set null" }),
    smoobuBookingId: text("smoobu_booking_id").unique(),
    smoobuApartmentId: integer("smoobu_apartment_id"),
    apartmentName: text("apartment_name"),
    chargeAutomationReference: text("charge_automation_reference").unique(),
    guestName: text("guest_name").notNull(),
    channel: text("channel"),
    status: bookingStatusEnum("status").notNull().default("confirmed"),
    arrivalDate: date("arrival_date").notNull(),
    departureDate: date("departure_date").notNull(),
    // Expected times as entered in Smoobu, e.g. "16:00".
    checkInTime: text("check_in_time"),
    checkOutTime: text("check_out_time"),
    adults: integer("adults"),
    children: integer("children"),
    checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
    totalAmount: money("total_amount"),
    pricePaid: boolean("price_paid"),
    cleaningFee: money("cleaning_fee"),
    smoobuModifiedAt: timestamp("smoobu_modified_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index("short_stay_bookings_property_dates_idx").on(t.propertyId, t.departureDate),
    index("short_stay_bookings_apartment_dates_idx").on(t.smoobuApartmentId, t.departureDate),
    index("short_stay_bookings_arrival_idx").on(t.arrivalDate),
    index("short_stay_bookings_room_id_idx").on(t.roomId),
    check("short_stay_bookings_dates_chk", sql`${t.departureDate} >= ${t.arrivalDate}`),
  ],
).enableRLS();

export const paymentSourceEnum = pgEnum("payment_source", [
  "coho",
  "smoobu",
  "charge_automation",
  "xero",
  "manual",
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "paid",
  "failed",
  "refunded",
]);

// Incoming rent and booking payments. Xero stays the ledger of record;
// xero_payment_id links each row to it once reconciled.
export const paymentsTable = pgTable(
  "payments",
  {
    id: id(),
    source: paymentSourceEnum("source").notNull(),
    externalId: text("external_id"),
    tenancyId: uuid("tenancy_id").references(() => tenanciesTable.id, { onDelete: "restrict" }),
    bookingId: uuid("booking_id").references(() => shortStayBookingsTable.id, { onDelete: "restrict" }),
    amount: money("amount").notNull(),
    currency: text("currency").notNull().default("GBP"),
    status: paymentStatusEnum("status").notNull().default("pending"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    xeroPaymentId: text("xero_payment_id").unique(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("payments_source_external_uq").on(t.source, t.externalId),
    index("payments_tenancy_id_idx").on(t.tenancyId),
    index("payments_booking_id_idx").on(t.bookingId),
    check("payments_one_target_chk", sql`num_nonnulls(${t.tenancyId}, ${t.bookingId}) <= 1`),
  ],
).enableRLS();

export const insertTenantSchema = createInsertSchema(tenantsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertTenancySchema = createInsertSchema(tenanciesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertShortStayBookingSchema = createInsertSchema(shortStayBookingsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertPaymentSchema = createInsertSchema(paymentsTable).omit({ id: true, createdAt: true, updatedAt: true });

export type Tenant = typeof tenantsTable.$inferSelect;
export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenancy = typeof tenanciesTable.$inferSelect;
export type InsertTenancy = z.infer<typeof insertTenancySchema>;
export type ShortStayBooking = typeof shortStayBookingsTable.$inferSelect;
export type InsertShortStayBooking = z.infer<typeof insertShortStayBookingSchema>;
export type Payment = typeof paymentsTable.$inferSelect;
export type InsertPayment = z.infer<typeof insertPaymentSchema>;
export type SmoobuApartment = typeof smoobuApartmentsTable.$inferSelect;
