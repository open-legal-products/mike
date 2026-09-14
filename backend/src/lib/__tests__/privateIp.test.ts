import { describe, expect, it } from "vitest";
import { isBlockedIp, isPrivateIpv4, isPrivateIpv6 } from "../privateIp";

describe("private/reserved IP classification", () => {
    it.each([
        "0.0.0.0",
        "10.0.0.1",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "192.0.0.1",
        "192.0.2.1",
        "192.88.99.1",
        "192.168.0.1",
        "198.18.0.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "240.0.0.1",
        "255.255.255.255",
    ])("blocks non-global IPv4 address %s", (ip) => {
        expect(isPrivateIpv4(ip)).toBe(true);
        expect(isBlockedIp(ip)).toBe(true);
    });

    it.each(["8.8.8.8", "93.184.216.34", "192.31.196.1"])(
        "allows globally reachable IPv4 address %s",
        (ip) => {
            expect(isPrivateIpv4(ip)).toBe(false);
            expect(isBlockedIp(ip)).toBe(false);
        },
    );

    it.each([
        "::",
        "::1",
        "::ffff:8.8.8.8",
        "::8.8.8.8",
        "100::1",
        "2001::1",
        "2001:2::1",
        "2001:10::1",
        "2001:db8::1",
        "2002::1",
        "3fff::1",
        "5f00::1",
        "fc00::1",
        "fd00::1",
        "fe80::1",
        "fec0::1",
        "ff02::1",
        "64:ff9b::10.0.0.1",
        "64:ff9b:1::1",
    ])("blocks non-global IPv6 address %s", (ip) => {
        expect(isPrivateIpv6(ip)).toBe(true);
        expect(isBlockedIp(ip)).toBe(true);
    });

    it.each([
        "2606:4700:4700::1111",
        "2001:4860:4860::8888",
        "64:ff9b::8.8.8.8",
    ])("allows globally reachable IPv6 address %s", (ip) => {
        expect(isPrivateIpv6(ip)).toBe(false);
        expect(isBlockedIp(ip)).toBe(false);
    });

    it.each(["1foo.2.3.4", "999.1.1.1", "not-an-ip"])(
        "fails closed for malformed address %s",
        (ip) => {
            expect(isPrivateIpv4(ip)).toBe(true);
            expect(isBlockedIp(ip)).toBe(true);
        },
    );

    // NAT64 prefix confusion: the 64:ff9b::/96 branch is the ONLY path where
    // an embedded IPv4 can make an IPv6 literal come back "allowed", so every
    // hextet of the prefix match is load-bearing. Each address below differs
    // from the well-known prefix in exactly one hextet while embedding a
    // PUBLIC IPv4 — if any single prefix comparison is loosened, the branch
    // treats the address as NAT64 and returns "allowed" for what is really a
    // non-global (blocked) destination. The earlier "64:ff9b:1::1" case can't
    // catch that, because its embedded IPv4 is private and blocks anyway.
    it.each([
        "63:ff9b::8.8.8.8", // wrong hextet 0
        "64:ff9a::8.8.8.8", // wrong hextet 1
        "64:ff9b:1::8.8.8.8", // local-use 64:ff9b:1::/48, hextet 2 set
        "64:ff9b:0:1::8.8.8.8", // hextet 3 set
        "64:ff9b::1:0:808:808", // hextet 4 set
        "64:ff9b:0:0:0:1:808:808", // hextet 5 set
    ])("blocks near-NAT64 address %s despite a public embedded IPv4", (ip) => {
        expect(isPrivateIpv6(ip)).toBe(true);
        expect(isBlockedIp(ip)).toBe(true);
    });

    // 0xffff is a VALID hextet, not an out-of-range value — pin the boundary
    // of the group-value check so it can't silently tighten to >= 0xffff and
    // start failing closed on legitimate global addresses.
    it("allows a global unicast address with an all-ones hextet", () => {
        expect(isPrivateIpv6("2606:4700::ffff")).toBe(false);
        expect(isBlockedIp("2606:4700::ffff")).toBe(false);
    });

    // Junk handed DIRECTLY to the v6 classifier (not routed via isBlockedIp)
    // must fail closed at both guards: the net.isIP gate and the null-groups
    // gate behind it.
    it.each(["not-an-ip", "8.8.8.8", "1:2:3:4:5:6:7:8:9", ""])(
        "isPrivateIpv6 fails closed on non-IPv6 input %s",
        (ip) => {
            expect(isPrivateIpv6(ip)).toBe(true);
        },
    );
});
