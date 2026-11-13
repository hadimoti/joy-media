/*
 * The one rule for internal addresses (S8 item 4, T-F07). The endpoint policy in registry.ts, the desktop pinned transport
 * and the CLI transport all judge a host with isPrivateOrInternalHost, so the address decoding lives here and nowhere
 * else. It is pure text decoding: it opens no socket and makes no DNS query, so the transports call it on each address
 * they are about to connect to.
 */

/** A host that is never a public endpoint: local names, private and link-local addresses, and cloud metadata. */
export function isPrivateOrInternalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === 'metadata' || host === 'metadata.google.internal') return true;
  if (host.endsWith('.internal') || host.endsWith('.local')) return true;
  return host.includes(':') ? isPrivateIpv6(host) : isPrivateIpv4(host);
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const numbers = parts.map(Number);
  if (numbers.some((part) => part > 255)) return false;
  const [first = -1, second = -1] = numbers;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

function isPrivateIpv6(host: string): boolean {
  if (host === '::' || host === '::1') return true;
  // Unique-local fc00::/7, link-local fe80::/10 and the deprecated site-local fec0::/10 are never public.
  if (/^f[cd]/.test(host) || /^fe[89a-f]/.test(host)) return true;
  // Multicast (ff00::/8) is never a public endpoint.
  if (/^ff/.test(host)) return true;
  // IPv4-mapped in the dotted form, ::ffff:127.0.0.1, is judged by its IPv4 address.
  const dotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted?.[1] !== undefined) return isPrivateIpv4(dotted[1]);
  const mapped = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped?.[1] !== undefined && mapped[2] !== undefined) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return isPrivateEmbeddedIpv4(host);
}

/** The eight 16-bit groups of an IPv6 address written as text, or undefined when the text is not one. */
function ipv6Groups(text: string): number[] | undefined {
  const sides = text.split('::');
  if (sides.length > 2) return undefined;
  const parse = (side: string, endsAddress: boolean): number[] | undefined => {
    if (side === '') return [];
    const pieces = side.split(':');
    const groups: number[] = [];
    for (const [index, piece] of pieces.entries()) {
      const dotted =
        endsAddress && index === pieces.length - 1
          ? /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(piece)
          : null;
      if (dotted !== null) {
        const octets = dotted.slice(1).map(Number);
        if (octets.some((octet) => octet > 255)) return undefined;
        const [a = 0, b = 0, c = 0, d = 0] = octets;
        groups.push(a * 256 + b, c * 256 + d);
      } else if (/^[0-9a-f]{1,4}$/i.test(piece)) {
        groups.push(Number.parseInt(piece, 16));
      } else {
        return undefined;
      }
    }
    return groups;
  };
  if (sides.length === 1) {
    const whole = parse(text, true);
    return whole?.length === 8 ? whole : undefined;
  }
  const head = parse(sides[0] ?? '', false);
  const tail = parse(sides[1] ?? '', true);
  if (head === undefined || tail === undefined) return undefined;
  const missing = 8 - head.length - tail.length;
  return missing < 1 ? undefined : [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/** The bit at position `bit` of a 128-bit address, counted from the most significant bit, which is bit 0. */
function bitAt(groups: readonly number[], bit: number): number {
  const group = groups[bit >> 4] ?? 0;
  return (group >> (15 - (bit & 15))) & 1;
}

/**
 * The 32 bit positions that carry an IPv4 address after a prefix of this length, in RFC 6052 layout. Bits 64 to 71 are
 * the reserved u octet, so they are skipped for prefixes shorter than 72 bits.
 */
function ipv4PositionsAfter(prefixLength: number): number[] {
  const positions: number[] = [];
  for (let bit = prefixLength; positions.length < 32; bit += 1) {
    if (bit >= 64 && bit < 72) continue;
    positions.push(bit);
  }
  return positions;
}

/** The IPv4 address, as a 32-bit number, that the given bit positions of an IPv6 address carry. */
function ipv4At(groups: readonly number[], positions: readonly number[]): number {
  let value = 0;
  for (const bit of positions) value = value * 2 + bitAt(groups, bit);
  return value;
}

/**
 * Private or loopback, for an IPv4 address carried in a prefix that is not an IPv4 form: 10/8, 172.16/12, 192.168/16,
 * 127/8 and 169.254/16. A zero first octet is the zero fill of a prefix, not an address, so it is not judged.
 */
function isPrivateOrLoopbackCarried(value: number): boolean {
  const first = value >>> 24;
  const second = (value >>> 16) & 255;
  if (first === 0) return false;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

/**
 * Whether the bits outside the prefix and outside the IPv4 address are all zero. A NAT64 gateway writes only this
 * shape (RFC 6052 section 2.4), so an address of another shape is not judged by its IPv4 bits.
 */
function hasTranslatedShape(groups: readonly number[], prefixLength: number): boolean {
  const embedded = new Set(ipv4PositionsAfter(prefixLength));
  for (let bit = prefixLength; bit < 128; bit += 1) {
    if (!embedded.has(bit) && bitAt(groups, bit) !== 0) return false;
  }
  return true;
}

/** Prefix lengths of the RFC 6052 network-specific NAT64 prefixes that have reserved or suffix bits to check. */
const SHAPED_PREFIX_LENGTHS: readonly number[] = [40, 48, 56, 64];

/**
 * An IPv6 address that carries an IPv4 address. Each form is listed with its own rule:
 *
 * - The mapped form, in any spelling, and the translated form ::ffff:0:a.b.c.d are judged by the IPv4 address they carry.
 * - The NAT64 well-known prefix 64:ff9b::/96 is judged by the IPv4 address it carries: a DNS64 network returns that
 *   prefix for a public IPv4-only server. The NAT64 local-use prefix 64:ff9b:1::/48 is refused whatever it carries.
 * - The IPv4-compatible ::/96 and 6to4 2002::/16 are refused whatever IPv4 address they carry.
 * - The ISATAP interface identifier 0000:5efe or 0200:5efe (RFC 5214), under any prefix, is judged by the IPv4 address that
 *   follows it.
 * - A network-specific NAT64 prefix (RFC 6052) or a 6rd prefix (RFC 5969) has no fixed length, so each length that
 *   carries an IPv4 address is checked. A /32 or /96 carrier is refused when its IPv4 is private or loopback. A /40 to
 *   /64 carrier is refused only when the rest of the address has the translated shape, which keeps ordinary addresses
 *   out of the refusal. A 6rd prefix of another length is not judged.
 */
function isPrivateEmbeddedIpv4(host: string): boolean {
  const groups = ipv6Groups(host);
  if (groups === undefined) return false;
  const leading = (count: number): boolean => groups.slice(0, count).every((group) => group === 0);
  const embeddedPrivate = (): boolean => {
    const [high = 0, low = 0] = groups.slice(6);
    return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  };
  if (leading(5) && groups[5] === 0xffff) return embeddedPrivate();
  if (leading(4) && groups[4] === 0xffff && groups[5] === 0) return embeddedPrivate();
  const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b;
  if (nat64 && groups[2] === 1) return true;
  if (nat64 && groups.slice(2, 6).every((group) => group === 0)) return embeddedPrivate();
  if (leading(6)) return true;
  if (groups[0] === 0x2002) return true;
  if ((groups[4] === 0 || groups[4] === 0x0200) && groups[5] === 0x5efe) return embeddedPrivate();
  if (isPrivateOrLoopbackCarried(ipv4At(groups, ipv4PositionsAfter(32)))) return true;
  if (isPrivateOrLoopbackCarried(ipv4At(groups, ipv4PositionsAfter(96)))) return true;
  return SHAPED_PREFIX_LENGTHS.some(
    (length) =>
      isPrivateOrLoopbackCarried(ipv4At(groups, ipv4PositionsAfter(length))) &&
      hasTranslatedShape(groups, length),
  );
}
