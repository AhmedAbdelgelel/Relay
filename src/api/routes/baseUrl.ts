import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";

/** Tenant-supplied upstream base URL for a provider connection. */
export const BASE_URL_MAX_LENGTH = 300;

/**
 * SSRF policy for tenant-supplied provider base URLs (`POST /v1/register`,
 * `POST /v1/connections`). The gateway will POST the tenant's credential to
 * this URL, so a public URL is not enough: it must not be able to point the
 * gateway at itself, at private infrastructure, or at cloud metadata.
 *
 * `allowPrivate: false` (default) allows only globally routable addresses.
 * `allowPrivate: true` is the explicit opt-in for legitimate self-hosted
 * endpoints (e.g. Ollama on 127.0.0.1/10.x); it still rejects unspecified,
 * multicast and reserved ranges, credentials in the URL, and non-http(s).
 */
export interface ProviderUrlPolicy {
  allowPrivate: boolean;
}

export function providerUrlPolicy(allowPrivateProviderUrls: boolean | undefined): ProviderUrlPolicy {
  return { allowPrivate: allowPrivateProviderUrls === true };
}

export type DnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export interface ProviderUrlValid {
  ok: true;
  url: URL;
  /** Canonical WHATWG form; call sites may persist this instead of the raw input. */
  normalized: string;
}
export interface ProviderUrlInvalid {
  ok: false;
  /** Stable, safe reason (never echoes the submitted value). */
  error: string;
}
export type ProviderUrlValidation = ProviderUrlValid | ProviderUrlInvalid;

/** Default resolver used outside tests; injected resolver keeps unit tests offline. */
export const defaultDnsLookup: DnsLookup = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true }).then((rows) =>
    rows.map((row) => ({ address: row.address, family: row.family })),
  );

const REASON_TYPE = "base_url must be a string";
const REASON_EMPTY = "base_url must be an http(s) URL";
const REASON_TOO_LONG = `base_url is too long (max ${BASE_URL_MAX_LENGTH} chars)`;
const REASON_CREDENTIALS = "base_url must not embed credentials (user:password@host)";
const REASON_NO_HOST = "base_url must include a host";
const REASON_BLOCKED =
  "base_url host is not allowed: loopback, private, link-local, unspecified, multicast and reserved " +
  "addresses are blocked (set ALLOW_PRIVATE_PROVIDER_URLS=1 only for a trusted self-hosted endpoint)";
const REASON_UNRESOLVED = "base_url host could not be resolved";
const REASON_CONTROL = "base_url contains control characters";
const REASON_PORT = "base_url port 0 is not allowed";

function invalid(error: string): ProviderUrlInvalid {
  return { ok: false, error };
}

// ---------------------------------------------------------------- IPv4
function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

type AddressClass = "public" | "private" | "unspecified" | "multicast" | "reserved" | "invalid";

function inV4Range(value: number, network: string, bits: number): boolean {
  const base = ipv4ToInt(network);
  if (base === null) return false;
  const size = 2 ** (32 - bits);
  return value >= base && value < base + size;
}

const V4_RULES: ReadonlyArray<readonly [network: string, bits: number, klass: AddressClass]> = [
  ["0.0.0.0", 8, "unspecified"],
  ["127.0.0.0", 8, "private"], // loopback: local-only, opt-in
  ["10.0.0.0", 8, "private"], // RFC1918
  ["172.16.0.0", 12, "private"], // RFC1918
  ["192.168.0.0", 16, "private"], // RFC1918
  ["169.254.0.0", 16, "private"], // link-local (cloud metadata lives here)
  ["100.64.0.0", 10, "private"], // CGNAT / carrier-grade NAT
  ["192.0.0.0", 24, "reserved"], // IETF protocol assignments
  ["192.0.2.0", 24, "reserved"], // TEST-NET-1
  ["198.18.0.0", 15, "reserved"], // benchmarking
  ["198.51.100.0", 24, "reserved"], // TEST-NET-2
  ["203.0.113.0", 24, "reserved"], // TEST-NET-3
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"], // includes 255.255.255.255
];

function classifyIpv4Number(value: number): AddressClass {
  for (const [network, bits, klass] of V4_RULES) {
    if (inV4Range(value, network, bits)) return klass;
  }
  return "public";
}

function classifyIpv4(address: string): AddressClass {
  const value = ipv4ToInt(address);
  return value === null ? "invalid" : classifyIpv4Number(value);
}

// ---------------------------------------------------------------- IPv6
function parseHextet(part: string): number | null {
  if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
  return Number.parseInt(part, 16);
}

/** Parse an IPv6 literal (no brackets) to a 128-bit integer; null when invalid. */
function parseIpv6ToBigInt(raw: string): bigint | null {
  let value = raw.trim().toLowerCase();
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (value === "") return null;

  const lastColon = value.lastIndexOf(":");
  if (lastColon >= 0) {
    const tail = value.slice(lastColon + 1);
    if (tail.includes(".")) {
      const embedded = ipv4ToInt(tail);
      if (embedded === null) return null;
      const hi = (embedded >>> 16) & 0xffff;
      const lo = embedded & 0xffff;
      value = `${value.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
    }
  }

  const sides = value.split("::");
  if (sides.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === "") return [];
    const parts = side.split(":");
    const groups: number[] = [];
    for (const part of parts) {
      const group = parseHextet(part);
      if (group === null) return null;
      groups.push(group);
    }
    return groups;
  };
  const head = sides[0] === "" ? [] : parseSide(sides[0]!);
  const tail = sides.length === 2 ? (sides[1] === "" ? [] : parseSide(sides[1]!)) : null;
  if (head === null) return null;
  let groups: number[];
  if (tail === null) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    if (head.length + tail.length >= 8) return null; // "::" must elide at least one hextet
    groups = [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  }
  let big = 0n;
  for (const group of groups) big = (big << 16n) | BigInt(group);
  return big;
}

function inV6Range(value: bigint, network: string, bits: number): boolean {
  const base = parseIpv6ToBigInt(network);
  if (base === null) return false;
  const shift = BigInt(128 - bits);
  return value >> shift === base >> shift;
}

function classifyIpv6(value: bigint): AddressClass {
  if (value === 0n) return "unspecified"; // ::
  if (value === 1n) return "private"; // ::1 loopback
  if (inV6Range(value, "fe80::", 10)) return "private"; // link-local
  if (inV6Range(value, "fc00::", 7)) return "private"; // unique local
  if (inV6Range(value, "ff00::", 8)) return "multicast";
  if (inV6Range(value, "2001:db8::", 32)) return "reserved"; // documentation
  if (inV6Range(value, "::ffff:0:0", 96) || inV6Range(value, "64:ff9b::", 96)) {
    return classifyIpv4Number(Number(value & 0xffffffffn)); // IPv4-mapped / NAT64
  }
  if (inV6Range(value, "2002::", 16)) {
    // 6to4 embeds an IPv4 address in bits 16..48; don't let it hide loopback.
    return classifyIpv4Number(Number((value >> 80n) & 0xffffffffn));
  }
  if (inV6Range(value, "::", 96)) return "reserved"; // deprecated IPv4-compatible space
  return "public";
}

function classifyAddress(address: string): AddressClass {
  const scoped = address.includes("%");
  const literal = scoped ? address.slice(0, address.indexOf("%")) : address;
  const family = isIP(literal);
  if (family === 4) return classifyIpv4(literal);
  if (family === 6) {
    const big = parseIpv6ToBigInt(literal);
    if (big === null) return "invalid";
    return scoped ? "private" : classifyIpv6(big);
  }
  return "invalid";
}

function addressAllowed(address: string, allowPrivate: boolean): boolean {
  const klass = classifyAddress(address);
  if (klass === "public") return true;
  if (klass === "private") return allowPrivate;
  return false;
}

// ---------------------------------------------------------------- URL helpers
function stripBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** Raw authority slice, used to catch empty-userinfo forms (`http://@host`). */
function rawAuthority(value: string): string | null {
  const match = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value);
  if (!match) return null;
  const rest = value.slice(match[0].length);
  const end = rest.search(/[/?#]/);
  return end === -1 ? rest : rest.slice(0, end);
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

/** http(s) only static check (scheme only; no network policy). */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Shape-only schema kept for backward compatibility (scheme + length). It
 * cannot express the SSRF/network policy synchronously, so every call site
 * that stores a tenant base_url must also await validateProviderBaseUrl().
 */
export const BaseUrlShapeSchema = z
  .string()
  .trim()
  .max(BASE_URL_MAX_LENGTH, "base_url is too long")
  .refine(isHttpUrl, "base_url must be an http(s) URL");

/** @deprecated static shape only; does not enforce the SSRF/network policy. Use validateProviderBaseUrl. */
export const BaseUrlSchema = BaseUrlShapeSchema;

export interface ProviderBaseUrlValidationOptions {
  policy: ProviderUrlPolicy;
  lookup?: DnsLookup;
}

/**
 * Validate a tenant-supplied provider base URL against the SSRF policy.
 *
 * Never throws; returns {ok:false, error} for call sites to map to 400
 * `invalid_request`. Hostnames are resolved and *every* answer must pass the
 * policy (a mixed public/private set is rejected). Only http(s), no embedded
 * credentials, no control characters.
 *
 * Residual risk: validation happens when the URL is stored; the gateway
 * re-resolves the hostname at request time, so DNS rebinding / TOCTOU can
 * still point a previously-public host at a private address. Mitigations
 * (out of scope here): pin the validated IP and connect to it with a Host
 * header, or revalidate immediately before each upstream call.
 */
export async function validateProviderBaseUrl(
  raw: unknown,
  options: ProviderBaseUrlValidationOptions,
): Promise<ProviderUrlValidation> {
  const { policy, lookup = defaultDnsLookup } = options;
  const allowPrivate = policy.allowPrivate === true;

  if (typeof raw !== "string") return invalid(REASON_TYPE);
  const value = raw.trim();
  if (value === "") return invalid(REASON_EMPTY);
  if (value.length > BASE_URL_MAX_LENGTH) return invalid(REASON_TOO_LONG);
  if (hasControlCharacters(value)) return invalid(REASON_CONTROL);

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid(REASON_EMPTY);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return invalid(REASON_EMPTY);

  const authority = rawAuthority(value);
  if (authority !== null && authority.includes("@")) return invalid(REASON_CREDENTIALS);
  if (url.username !== "" || url.password !== "") return invalid(REASON_CREDENTIALS);
  if (url.hostname === "") return invalid(REASON_NO_HOST);
  if (url.port === "0") return invalid(REASON_PORT);

  const hostname = stripBrackets(url.hostname);
  const zoneIndex = hostname.indexOf("%");
  const literal = zoneIndex >= 0 ? hostname.slice(0, zoneIndex) : hostname;
  const bareHost = literal.toLowerCase().replace(/\.$/, "");
  if (bareHost === "") return invalid(REASON_NO_HOST);

  if (isIP(bareHost) !== 0) {
    if (zoneIndex >= 0 && !allowPrivate) return invalid(REASON_BLOCKED);
    return addressAllowed(bareHost, allowPrivate) ? { ok: true, url, normalized: url.toString() } : invalid(REASON_BLOCKED);
  }

  // `localhost` (and *.localhost) are loopback names per RFC 6761; never resolve them.
  if (bareHost === "localhost" || bareHost.endsWith(".localhost")) {
    return allowPrivate ? { ok: true, url, normalized: url.toString() } : invalid(REASON_BLOCKED);
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(bareHost);
  } catch {
    return invalid(REASON_UNRESOLVED);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return invalid(REASON_UNRESOLVED);
  for (const entry of addresses) {
    const address = typeof entry?.address === "string" ? entry.address : "";
    if (!addressAllowed(address, allowPrivate)) return invalid(REASON_BLOCKED);
  }
  return { ok: true, url, normalized: url.toString() };
}

/** Factory form for dependency-injected call sites/tests. */
export function createProviderBaseUrlValidator(
  policy: ProviderUrlPolicy,
  lookup: DnsLookup = defaultDnsLookup,
): (raw: unknown) => Promise<ProviderUrlValidation> {
  return (raw) => validateProviderBaseUrl(raw, { policy, lookup });
}
