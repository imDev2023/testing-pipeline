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
    const { wire, version } = fitTransaction([instruction(accounts(10))], TRADER, LIFETIME, null);
    expect(version).toBe("legacy");
    expect(size(wire)).toBeLessThanOrEqual(1232);
  });

  it("shortens one that does not fit with the market's recorded lookup table, as a version 0 transaction", () => {
    const keys = accounts(40);
    expect(() => fitTransaction([instruction(keys)], TRADER, LIFETIME, null)).toThrow(TooLarge);
    const { wire, version } = fitTransaction([instruction(keys)], TRADER, LIFETIME, { address: accounts(1, 200)[0]!, addresses: keys });
    expect(version).toBe(0);
    expect(size(wire)).toBeLessThanOrEqual(1232);
  });

  it("refuses one that does not fit even with the table, saying why", () => {
    const keys = accounts(60);
    expect(() => fitTransaction([instruction(keys)], TRADER, LIFETIME, { address: accounts(1, 200)[0]!, addresses: keys.slice(0, 2) })).toThrow(
      "This swap needs more accounts than one transaction can carry, even with its market's address lookup table.",
    );
  });
});
