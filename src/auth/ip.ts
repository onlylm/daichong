import ipaddr from "ipaddr.js";

export function normalizeIpRules(rules: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const value of rules) {
    const rule = value.trim();
    if (!rule) continue;
    try {
      if (rule.includes("/")) {
        const [network, prefix] = ipaddr.parseCIDR(rule);
        if (network.kind() === "ipv6" && "isIPv4MappedAddress" in network && network.isIPv4MappedAddress()) {
          throw new Error("mapped_ipv4_cidr");
        }
        normalized.add(`${network.toString()}/${prefix}`);
      } else {
        normalized.add(ipaddr.process(rule).toString());
      }
    } catch {
      throw new Error(`invalid_ip_rule:${rule}`);
    }
  }
  return [...normalized];
}

export function ipAllowed(remoteIp: string, rules: readonly string[]): boolean {
  if (rules.length === 0) return true;
  let address: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    address = ipaddr.process(remoteIp);
  } catch {
    return false;
  }
  return rules.some((rule) => {
    try {
      if (rule.includes("/")) {
        const [network, prefix] = ipaddr.parseCIDR(rule);
        const normalizedNetwork = ipaddr.process(network.toString());
        return address.kind() === normalizedNetwork.kind() && address.match(normalizedNetwork, prefix);
      }
      const expected = ipaddr.process(rule);
      return address.kind() === expected.kind() && address.toString() === expected.toString();
    } catch {
      return false;
    }
  });
}
