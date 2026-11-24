// A form's fields and its accounts as the pages read them (docs/spec/pipescope-screens.md, Explanation,
// actions and facts; #123): what is typed into a field becomes the argument the API builds with, an
// amount written in its mint's decimals when the metadata names that mint; and each account the form
// touches is said in words, the market's own by their mints' names.
import { renderToStaticMarkup } from "react-dom/server";
import type { AccountSource, FormArg } from "terminal-api/contract";
import { describe, expect, it } from "vitest";
import { argValue, decimalsOf, type MintContext } from "@/formValues";
import { AccountWords } from "@/components/forms/AccountWords";

const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN = "AVimgQ4wqmdAk1C2ZSxbF3CnYv1o7b8mT1dWb2mR7eYx";
const FIXED = "8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2";
const arg = (type: FormArg["type"], name = "value"): FormArg => ({ name, type, label: null, description: null, decimals_of: null });
const context: MintContext = {
  market: [
    { mint: WSOL, symbol: "SOL", token: null, decimals: 9 },
    { mint: TOKEN, symbol: null, token: { symbol: "AVIMG", name: "Aviary Image Check", image: null }, decimals: 6 },
  ],
  inputs: { tax_mint: { mint: TOKEN, symbol: null, token: { symbol: "AVIMG", name: null, image: null }, decimals: 6 } },
};

const textOf = (html: string) => html.replace(/<[^>]+>/g, "").replaceAll("&#x27;", "'").replaceAll("&amp;", "&");

describe("argValue", () => {
  it("takes an integer within its type's range, and says the range of one beyond it", () => {
    expect(argValue(arg("u16"), "600", null)).toEqual({ kind: "ok", value: "600" });
    expect(argValue(arg("u16"), "70000", null)).toEqual({ kind: "invalid", reason: "A u16 is a whole number from 0 to 65,535." });
    expect(argValue(arg("u8"), "-1", null)).toEqual({ kind: "invalid", reason: "A u8 is a whole number from 0 to 255." });
    expect(argValue(arg("i64"), "-42", null)).toEqual({ kind: "ok", value: "-42" });
    expect(argValue(arg("u64"), "1.5", null)).toEqual({ kind: "invalid", reason: "A u64 is a whole number from 0 to 18,446,744,073,709,551,615." });
  });

  it("reads an amount in its mint's decimals into base units when the metadata names the mint", () => {
    expect(argValue(arg("u64"), "0.25", 9)).toEqual({ kind: "ok", value: "250000000" });
    expect(argValue(arg("u64"), "0", 9)).toEqual({ kind: "ok", value: "0" });
    expect(argValue(arg("u64"), "0.0000001", 6)).toEqual({ kind: "invalid", reason: "This token has 6 decimal places." });
    expect(argValue(arg("u8"), "300", 0)).toEqual({ kind: "invalid", reason: "A u8 is a whole number from 0 to 255." });
  });

  it("takes an address, a boolean, bytes in hex and text", () => {
    expect(argValue(arg("pubkey"), FIXED, null)).toEqual({ kind: "ok", value: FIXED });
    expect(argValue(arg("pubkey"), "not-an-address", null)).toEqual({ kind: "invalid", reason: "Type an address: 32 to 44 characters of base58." });
    expect(argValue(arg("bool"), true, null)).toEqual({ kind: "ok", value: true });
    expect(argValue(arg("bool"), undefined, null)).toEqual({ kind: "ok", value: false });
    expect(argValue(arg("bytes"), "0xdeadbeef", null)).toEqual({ kind: "ok", value: "0xdeadbeef" });
    expect(argValue(arg("bytes"), "xyz", null)).toEqual({ kind: "invalid", reason: "Type bytes in hex, two digits each, such as 0a1b." });
    expect(argValue(arg("string"), "hello", null)).toEqual({ kind: "ok", value: "hello" });
  });

  it("says a field is empty until something is typed, except a boolean and text", () => {
    expect(argValue(arg("u16"), "", null)).toEqual({ kind: "empty" });
    expect(argValue(arg("pubkey"), "  ", null)).toEqual({ kind: "empty" });
    expect(argValue(arg("string"), "", null)).toEqual({ kind: "ok", value: "" });
  });
});

describe("decimalsOf", () => {
  it("finds the decimals of the market's mint or of a mint the user entered", () => {
    expect(decimalsOf({ kind: "mint", index: 0 }, context)).toBe(9);
    expect(decimalsOf({ kind: "input", name: "tax_mint" }, context)).toBe(6);
    expect(decimalsOf({ kind: "input", name: "nothing_yet" }, context)).toBeNull();
    expect(decimalsOf(null, context)).toBeNull();
  });
});

describe("AccountWords", () => {
  const words = (source: AccountSource) => textOf(renderToStaticMarkup(<AccountWords source={source} context={context} />));

  it("says what each kind of account is", () => {
    expect(words({ kind: "wallet" })).toBe("your wallet");
    expect(words({ kind: "market_state" })).toBe("the market's state");
    expect(words({ kind: "market" })).toBe("the market's account with Pipeline's router");
    expect(words({ kind: "vault", index: 0 })).toBe("the market's vault for SOL");
    expect(words({ kind: "wallet_token_account", index: 1 })).toBe("your token account for AVIMG AVim...7eYx");
    expect(words({ kind: "fixed", address: FIXED })).toBe("a fixed address");
    expect(words({ kind: "input", name: "recipient" })).toBe("the address you enter as recipient");
    expect(words({ kind: "system_program" })).toBe("the System program");
    expect(words({ kind: "token_program_of", mint: { kind: "input", name: "tax_mint" } })).toBe("the token program of the mint you enter as tax_mint");
    expect(words({ kind: "pda", program: "strategy", seeds: [{ kind: "str", text: "authority" }] })).toBe("an address derived from the program itself by a rule in the metadata");
    expect(words({ kind: "pda", program: FIXED, seeds: [] })).toBe("an address derived from another program by a rule in the metadata");
    expect(words({ kind: "ata", owner: { kind: "wallet" }, mint: { kind: "mint", index: 0 } })).toBe("your token account for SOL");
    expect(words({ kind: "ata", owner: { kind: "input", name: "recipient" }, mint: { kind: "input", name: "tax_mint" } })).toBe("the token account of the address you enter as recipient for the mint you enter as tax_mint");
  });

  it("sets a token's own name in the author's style, with its short address beside it", () => {
    const html = renderToStaticMarkup(<AccountWords source={{ kind: "vault", index: 1 }} context={context} />);
    expect(html).toMatch(/class="[^"]*author[^"]*">AVIMG</);
  });
});
