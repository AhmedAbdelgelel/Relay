
import { z } from "zod";

/** http(s) only: the gateway will POST upstream with the tenant's key, so
 * scheme-level sanity is the floor (localhost endpoints are legitimate). */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Tenant-supplied upstream base URL for a provider connection. */
export const BaseUrlSchema = z
  .string()
  .trim()
  .max(300, "base_url is too long")
  .refine(isHttpUrl, "base_url must be an http(s) URL");
