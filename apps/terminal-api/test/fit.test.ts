import { AccountRole, address, blockhash, getAddressDecoder, getBase64Encoder, type Address, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { fitTransaction, TooLarge } from "../src/trading/prepare";

const TRADER = address("E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW");
const PROGRAM = address("yRptCdde1du1JYR2DcNFtLC1fkp5Asd6rE3XSvZoUFx");
const LIFETIME = { blockhash: blockhash("85wnSLSYPdHaM8ad4F4MS7JpmrkaYcaSntKMVpiFAG4N"), lastValidBlockHeight: 1n };
const decode = getAddressDecoder();
/** `n` distinct made-up accounts. */
const accounts = (n: number, from = 1): Address[] => Array.from({ length: n }, (_, i) => decode.decode(new Uint8Array(32).fill(0).map((_, j) => (j === 0 ? (from + i) % 256 : j === 1 ? Math.floor((from + i) / 256) : 7))));
const instruction = (keys: Address[]): Instruction => ({ programAddress: PROGRAM, accounts: keys.map((k) => ({ address: k, role: AccountRole.WRITABLE })), data: new Uint8Array([1, 2, 3]) });
const size = (wire: string) => getBase64Encoder().encode(wire).length;

describe("fitting a swap into one transaction", () => {
  it("keeps a legacy transaction when it fits, as Pipeline's own builder makes it", () => {
    const { wire, version } = fitTransaction([instruction(accounts(10))], TRADER, LIFETIME, []);
    expect(version).toBe("legacy");
    expect(size(wire)).toBeLessThanOrEqual(1232);
  });

  it("shortens one that does not fit with the market's recorded lookup table, as a version 0 transaction", () => {
    const keys = accounts(40);
    expect(() => fitTransaction([instruction(keys)], TRADER, LIFETIME, [])).toThrow("This swap needs more accounts than one transaction can carry, and its market has recorded no address lookup table to shorten it.");
    const { wire, version } = fitTransaction([instruction(keys)], TRADER, LIFETIME, [{ address: accounts(1, 200)[0]!, addresses: keys, whose: "market" }]);
    expect(version).toBe(0);
    expect(size(wire)).toBeLessThanOrEqual(1232);
  });

  it("refuses one that does not fit even with the table, saying why", () => {
    const keys = accounts(60);
    expect(() => fitTransaction([instruction(keys)], TRADER, LIFETIME, [{ address: accounts(1, 200)[0]!, addresses: keys.slice(0, 2), whose: "market" }])).toThrow(
      "This swap needs more accounts than one transaction can carry, even with its market's address lookup table.",
    );
    expect(() => fitTransaction([instruction(keys)], TRADER, LIFETIME, [{ address: accounts(1, 201)[0]!, addresses: keys.slice(2, 4), whose: "aviary" }])).toThrow(
      "This swap needs more accounts than one transaction can carry, even with Aviary's address lookup table.",
    );
    expect(() =>
      fitTransaction([instruction(keys)], TRADER, LIFETIME, [
        { address: accounts(1, 200)[0]!, addresses: keys.slice(0, 2), whose: "market" },
        { address: accounts(1, 201)[0]!, addresses: keys.slice(2, 4), whose: "aviary" },
      ]),
    ).toThrow("This swap needs more accounts than one transaction can carry, even with its market's address lookup table and Aviary's.");
  });

  it("shortens one with every table it is given at once: the market's and Aviary's (PIPESCOPE-164)", () => {
    // At most 64 accounts a transaction, so a long instruction makes half the accounts in one table too many.
    const keys = accounts(56);
    const long: Instruction = { ...instruction(keys), data: new Uint8Array(200) };
    const market = { address: accounts(1, 200)[0]!, addresses: keys.slice(0, 28), whose: "market" as const };
    const aviary = { address: accounts(1, 201)[0]!, addresses: keys.slice(28), whose: "aviary" as const };
    expect(() => fitTransaction([long], TRADER, LIFETIME, [market])).toThrow(TooLarge);
    expect(() => fitTransaction([long], TRADER, LIFETIME, [aviary])).toThrow(TooLarge);
    const { wire, version } = fitTransaction([long], TRADER, LIFETIME, [market, aviary]);
    expect(version).toBe(0);
    expect(size(wire)).toBeLessThanOrEqual(1232);
  });
});
