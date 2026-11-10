// `status`: per reserve, the total supply, the amount borrowed, the free liquidity, the utilisation, the stored rate
// and the flags, decoded at the spec's offsets (src/layout.ts), plus the lending market's emergency mode.
import type { Context } from "./context.ts";
import { readReserve } from "./ctokens.ts";
import { readLendingMarket } from "./emergency.ts";
import { freeLiquidity, storedRate, totalSupplySf, utilisationBps, type ReserveView } from "./layout.ts";
import { RESERVES, RESERVE_KEYS, type ReserveKey } from "./policy.ts";

export interface ReserveStatus {
  key: ReserveKey;
  address: string;
  totalSupply: bigint;
  borrowed: bigint;
  freeLiquidity: bigint;
  utilisationBps: bigint;
  storedRate: string;
  status: number;
  emergencyMode: number;
  blockCtokenUsage: number;
  reserve: ReserveView;
}

export interface StatusReport {
  marketEmergencyMode: number;
  reserves: ReserveStatus[];
  text: string;
}

const STATUS_NAMES = ["active", "obsolete", "hidden"];

export async function statusReport(ctx: Context): Promise<StatusReport> {
  const market = await readLendingMarket(ctx);
  const reserves: ReserveStatus[] = [];
  const lines = [`Lending market ${ctx.book.lendingMarket.address}: emergency mode ${onOff(market.emergencyMode)}`];
  for (const key of RESERVE_KEYS) {
    const r = await readReserve(ctx, key);
    const row: ReserveStatus = {
      key,
      address: ctx.book.reserves[key].address,
      totalSupply: totalSupplySf(r) >> 60n,
      // Rounded down like the total supply; a fully repaid reserve can keep less than a lamport of fixed-point dust.
      borrowed: r.borrowedAmountSf >> 60n,
      freeLiquidity: freeLiquidity(r),
      utilisationBps: utilisationBps(r),
      storedRate: storedRate(r),
      status: r.status,
      emergencyMode: r.emergencyMode,
      blockCtokenUsage: r.blockCtokenUsage,
      reserve: r,
    };
    reserves.push(row);
    const { label: name, decimals } = RESERVES[key];
    const amount = (value: bigint) => `${units(value, decimals)} ${name}`;
    const cap = r.depositWithdrawalCap;
    lines.push(
      `${name} reserve ${row.address}`,
      `  total supply     ${amount(row.totalSupply)}`,
      `  borrowed         ${amount(row.borrowed)}`,
      `  free liquidity   ${amount(row.freeLiquidity)}`,
      `  utilisation      ${units(row.utilisationBps, 2)}%`,
      `  stored rate      ${row.storedRate} ${name} per cToken`,
      `  flags            status ${STATUS_NAMES[r.status] ?? r.status}, emergency mode ${onOff(r.emergencyMode)}, ` +
        `block cToken usage ${onOff(r.blockCtokenUsage)}, market emergency mode ${onOff(market.emergencyMode)}`,
      `  deposit limit    ${amount(r.depositLimit)}`,
      `  withdrawal cap   net outflow ${amount(cap.current)} this interval, cap ${amount(cap.capacity)} per ${cap.intervalLength} s`,
      `  last update      slot ${r.lastUpdateSlot}, ${new Date(r.lastUpdateTimestamp * 1000).toISOString()}`,
    );
  }
  return { marketEmergencyMode: market.emergencyMode, reserves, text: lines.join("\n") };
}

function onOff(flag: number): string {
  return flag === 0 ? "off" : flag === 1 ? "on" : `unexpected value ${flag}`;
}

/** A base-unit amount as a decimal string with `decimals` places. */
export function units(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals > 0 ? `.${digits.slice(-decimals)}` : "";
  return `${negative ? "-" : ""}${whole}${fraction}`;
}
