/**
 * A tenant has exactly one brand pack, and it is always `brands/brand/`.
 *
 * The engine is shared by every client, so no client name may appear in it —
 * the dashboard writes the same folder name into every repository, and
 * multi-brand agencies get one repository each rather than one folder each.
 * BRAND_ID exists only as an escape hatch for local experiments.
 */
export const DEFAULT_BRAND = process.env.BRAND_ID ?? "brand";
