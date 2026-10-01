import ipaddr from "ipaddr.js";

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

