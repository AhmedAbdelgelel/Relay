import { describe, expect, it } from "vitest";
import {
  createProviderBaseUrlValidator,
  providerUrlPolicy,
  validateProviderBaseUrl,
  type DnsLookup,
  type ProviderUrlPolicy,
} from "../../src/api/routes/baseUrl.js";
import { loadConfig } from "../../src/infrastructure/config.js";

const DENY: ProviderUrlPolicy = providerUrlPolicy(false);
const ALLOW: ProviderUrlPolicy = providerUrlPolicy(true);

function resolverReturning(...addresses: string[]): DnsLookup {
  return async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
}

const noDns: DnsLookup = async () => {
  throw new Error("DNS resolver must not be called for IP-literal hosts");
};

async function rejected(raw: unknown, policy: ProviderUrlPolicy = DENY, lookup: DnsLookup = noDns): Promise<string> {
  const result = await validateProviderBaseUrl(raw, { policy, lookup });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error(`expected rejection for ${String(raw)}`);
  return result.error;
}

async function accepted(raw: unknown, policy: ProviderUrlPolicy = DENY, lookup: DnsLookup = noDns): Promise<string> {
  const result = await validateProviderBaseUrl(raw, { policy, lookup });
  if (!result.ok) throw new Error(`expected acceptance for ${String(raw)}, got: ${result.error}`);
  return result.normalized;
}

describe("provider base URL SSRF policy (deny by default)", () => {
  it("accepts public http(s) URLs (hostnames resolved, IP literals checked directly)", async () => {
    expect(await accepted("https://api.openai.com/v1", DENY, resolverReturning("104.18.32.7"))).toBe("https://api.openai.com/v1");
    expect(await accepted("https://openrouter.ai/api/v1", DENY, resolverReturning("104.18.32.7", "2606:4700::1111"))).toBe(
      "https://openrouter.ai/api/v1",
    );
    expect(await accepted("http://8.8.8.8:8080/v1")).toBe("http://8.8.8.8:8080/v1");
    expect(await accepted("https://[2606:4700:4700::1111]/v1")).toContain("2606:4700:4700::1111");
    expect(await accepted("https://[::ffff:8.8.8.8]/v1")).toContain("::ffff:808:808");
    expect(await accepted("http://172.32.0.1/v1")).toBe("http://172.32.0.1/v1");
  });

  it("passes the lowercased bare hostname to DNS and ignores a trailing dot", async () => {
    let asked = "";
    const lookup: DnsLookup = async (hostname) => {
      asked = hostname;
      return [{ address: "104.18.32.7", family: 4 }];
    };
    await accepted("https://API.OpenAI.com./v1", DENY, lookup);
    expect(asked).toBe("api.openai.com");
  });

  it("rejects loopback (IPv4, IPv6, localhost, obfuscated numeric forms)", async () => {
    for (const url of [
      "http://127.0.0.1:11434/v1",
      "http://127.1/",
      "http://127.10.20.30/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0177.0.0.1/",
      "http://[::1]:11434/v1",
      "http://localhost:11434/v1",
      "http://LOCALHOST/v1",
      "http://foo.localhost/v1",
      "http://127.0.0.1.nip.io/v1",
    ]) {
      expect(await rejected(url, DENY, resolverReturning("127.0.0.1"))).toMatch(/not allowed|http\(s\)/);
    }
  });

  it("rejects RFC1918 / CGNAT private ranges", async () => {
    for (const url of [
      "http://10.0.0.5:11434/v1",
      "http://10.255.255.255/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.10:11434/v1",
      "http://100.64.0.1/",
    ]) {
      expect(await rejected(url)).toMatch(/not allowed/);
    }
  });

  it("rejects link-local addresses, including the cloud metadata IP", async () => {
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://169.254.1.1/", "http://[fe80::1]/", "http://[fe80::abcd]/"]) {
      expect(await rejected(url)).toMatch(/not allowed/);
    }
  });

  it("rejects unspecified, multicast and reserved ranges", async () => {
    for (const url of [
      "http://0.0.0.0:11434/v1",
      "http://0.1.2.3/",
      "http://[::]/",
      "http://224.0.0.1/",
      "http://255.255.255.255/",
      "http://[ff02::1]/",
      "http://[2001:db8::1]/",
      "http://192.0.2.10/",
      "http://198.18.0.1/",
    ]) {
      expect(await rejected(url)).toMatch(/not allowed/);
    }
  });

  it("rejects IPv6 ULA and IPv4-mapped private addresses", async () => {
    for (const url of [
      "http://[fc00::1]/",
      "http://[fd12:3456:789a::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:10.0.0.1]/",
      "http://[::ffff:169.254.169.254]/",
    ]) {
      expect(await rejected(url)).toMatch(/not allowed/);
    }
  });

  it("rejects hostnames that resolve to any prohibited address", async () => {
    expect(await rejected("https://metadata.internal/v1", DENY, resolverReturning("169.254.169.254"))).toMatch(/not allowed/);
    expect(await rejected("https://internal.corp/v1", DENY, resolverReturning("10.1.2.3"))).toMatch(/not allowed/);
    // Mixed public/private answer sets are rejected (any private answer fails).
    expect(await rejected("https://split.example/v1", DENY, resolverReturning("104.18.32.7", "10.0.0.1"))).toMatch(/not allowed/);
    // Unresolvable / empty answers fail closed.
    const thrower: DnsLookup = async () => {
      throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
    };
    expect(await rejected("https://missing.example/v1", DENY, thrower)).toMatch(/could not be resolved/);
    expect(await rejected("https://empty.example/v1", DENY, resolverReturning())).toMatch(/could not be resolved/);
  });

  it("rejects embedded credentials, malformed URLs, bad schemes, port 0, oversize and non-strings", async () => {
    expect(await rejected("http://user:pass@api.example.com/v1", DENY, resolverReturning("104.18.32.7"))).toMatch(/credentials/);
    expect(await rejected("https://:sk-secret@api.example.com/v1", DENY, resolverReturning("104.18.32.7"))).toMatch(/credentials/);
    expect(await rejected("http://127.0.0.1@evil.example/v1", DENY, resolverReturning("104.18.32.7"))).toMatch(/credentials/);
    for (const url of ["", "   ", "not a url", "http://", "ftp://mirror.example/x", "file:///etc/passwd", "javascript:alert(1)"]) {
      await rejected(url);
    }
    expect(await rejected("https://api.example.com:0/v1", DENY, resolverReturning("104.18.32.7"))).toMatch(/port 0/);
    expect(await rejected(`https://api.example.com/${"a".repeat(400)}`, DENY, resolverReturning("104.18.32.7"))).toMatch(/too long/);
    expect(await rejected(123 as unknown)).toMatch(/string/);
    expect(await rejected(null as unknown)).toMatch(/string/);
    expect(await rejected({ url: "https://api.example.com" } as unknown)).toMatch(/string/);
  });

  it("does not echo the submitted value in validation errors (no secret/debug leak)", async () => {
    const error = await rejected("http://user:supersecret@127.0.0.1/v1");
    expect(error).not.toContain("supersecret");
    expect(error).not.toContain("127.0.0.1");
  });
});

describe("provider base URL opt-in (ALLOW_PRIVATE_PROVIDER_URLS)", () => {
  it("allows loopback/private/link-local/ULA self-hosted endpoints only behind the flag", async () => {
    for (const url of [
      "http://127.0.0.1:11434/v1",
      "http://localhost:11434/v1",
      "http://10.0.0.5:8080/v1",
      "http://192.168.1.10:11434/v1",
      "http://172.16.0.1/v1",
      "http://100.64.0.1/v1",
      "http://169.254.1.1/v1",
      "http://[::1]:11434/v1",
      "http://[fe80::1]/v1",
      "http://[fd12:3456:789a::1]/v1",
      "http://[::ffff:10.0.0.1]/v1",
      "https://ollama.local/v1",
    ]) {
      await accepted(url, ALLOW, resolverReturning("10.0.0.7"));
    }
  });

  it("still rejects credentials, non-http(s), unspecified, multicast and reserved under the opt-in", async () => {
    expect(await rejected("http://user:pass@127.0.0.1/v1", ALLOW)).toMatch(/credentials/);
    expect(await rejected("ftp://127.0.0.1/x", ALLOW)).toMatch(/http\(s\)/);
    expect(await rejected("http://0.0.0.0:11434/v1", ALLOW)).toMatch(/not allowed/);
    expect(await rejected("http://[::]:11434/v1", ALLOW)).toMatch(/not allowed/);
    expect(await rejected("http://224.0.0.1/", ALLOW)).toMatch(/not allowed/);
    expect(await rejected("http://[ff02::1]/", ALLOW)).toMatch(/not allowed/);
    expect(await rejected("http://[2001:db8::1]/", ALLOW)).toMatch(/not allowed/);
    expect(await rejected("not a url", ALLOW)).toMatch(/http\(s\)/);
  });

  it("createProviderBaseUrlValidator factory binds the policy", async () => {
    const deny = createProviderBaseUrlValidator(DENY);
    const allow = createProviderBaseUrlValidator(ALLOW);
    expect((await deny("http://127.0.0.1/")).ok).toBe(false);
    expect((await allow("http://127.0.0.1/")).ok).toBe(true);
  });

  it("providerUrlPolicy maps the config flag to the policy (undefined/false deny, true allow)", () => {
    expect(providerUrlPolicy(undefined)).toEqual({ allowPrivate: false });
    expect(providerUrlPolicy(false)).toEqual({ allowPrivate: false });
    expect(providerUrlPolicy(true)).toEqual({ allowPrivate: true });
  });
});

describe("ALLOW_PRIVATE_PROVIDER_URLS config parsing", () => {
  const load = (env: Record<string, string>) => loadConfig(env as NodeJS.ProcessEnv);

  it("defaults to deny when unset or empty", () => {
    expect(load({}).allowPrivateProviderUrls).toBe(false);
    expect(load({ ALLOW_PRIVATE_PROVIDER_URLS: "" }).allowPrivateProviderUrls).toBe(false);
  });

  it("accepts the documented truthy spellings and stays false for other values", () => {
    for (const raw of ["1", "true", "TRUE", "yes"]) {
      expect(load({ ALLOW_PRIVATE_PROVIDER_URLS: raw }).allowPrivateProviderUrls).toBe(true);
    }
    for (const raw of ["0", "false", "no", "off"]) {
      expect(load({ ALLOW_PRIVATE_PROVIDER_URLS: raw }).allowPrivateProviderUrls).toBe(false);
    }
  });
});
