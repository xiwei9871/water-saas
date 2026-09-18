// Global conventions:
// - Monetary amounts are stored/transported as bigint cents (`AmountCent`).
// - Decimal values inside DTOs are serialized as strings (`DecimalString`).

export type DecimalString = string;
export type AmountCent = bigint;
