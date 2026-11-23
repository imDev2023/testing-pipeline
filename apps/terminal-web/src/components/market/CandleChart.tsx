"use client";

// Adapted from Top-pad b833a7b, apps/web/src/components/coin/CandleChart.tsx; owned here since.
// The market page's chart (docs/spec/pipescope-screens.md, Chart; PIPESCOPE-69): TradingView
// Lightweight Charts v5 drawing Aviary's own candles for the pair on show, an up candle hollow and a
// down candle solid, both in ink, from the theme's tokens, so it follows the theme. Under it, the
// candle under the pointer, or the latest.
import { CandlestickSeries, ColorType, createChart, type CandlestickData, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import type { Candle } from "terminal-api/contract";
import { CHART_CANDLE_SPACING_PX } from "@/config";
import { formatDate, formatInteger, formatPrice } from "@/format";
import styles from "./Market.module.css";

/** A token of the theme, resolved to the colour it is now: tokens are written as light-dark(), which only an element can resolve. */
function themeColor(probe: HTMLElement, token: string): string {
  probe.style.color = `var(${token})`;
  return getComputedStyle(probe).color;
}

function palette(probe: HTMLElement) {
  const font = getComputedStyle(document.documentElement).getPropertyValue("--font-sans").trim();
  return { sheet: themeColor(probe, "--sheet"), ink: themeColor(probe, "--ink"), ink2: themeColor(probe, "--ink2"), rule: themeColor(probe, "--rule"), font };
}

type Bar = CandlestickData<UTCTimestamp>;
const barOf = (c: Candle): Bar => ({ time: (Date.parse(c.start) / 1000) as UTCTimestamp, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) });

export function CandleChart({ candles }: { candles: Candle[] }) {
  const box = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const drawn = useRef<Candle[]>([]);
  const [hovered, setHovered] = useState<Candle | null>(null);
  const latest = useRef(candles);
  useEffect(() => {
    latest.current = candles;
  });

  useEffect(() => {
    const colors = palette(probe.current!);
    const created = createChart(box.current!, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: colors.ink2, fontFamily: colors.font, fontSize: 12, attributionLogo: false },
      grid: { vertLines: { color: colors.rule }, horzLines: { color: colors.rule } },
      rightPriceScale: { borderColor: colors.rule, entireTextOnly: true, scaleMargins: { top: 0.14, bottom: 0.1 } },
      // A steady width per candle, the newest at the right with a little room, so a lone candle is drawn at a readable size.
      timeScale: { borderColor: colors.rule, timeVisible: true, secondsVisible: false, barSpacing: CHART_CANDLE_SPACING_PX, rightOffset: 2 },
      crosshair: { vertLine: { color: colors.ink2, labelBackgroundColor: colors.ink }, horzLine: { color: colors.ink2, labelBackgroundColor: colors.ink } },
      localization: { priceFormatter: formatPrice },
    });
    const candleSeries = created.addSeries(CandlestickSeries, {
      upColor: colors.sheet,
      downColor: colors.ink,
      borderUpColor: colors.ink,
      borderDownColor: colors.ink,
      wickUpColor: colors.ink,
      wickDownColor: colors.ink,
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: "custom", formatter: formatPrice, minMove: 1e-15 },
      // One swap, or swaps all at one price, would give the scale no height to draw in.
      autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } | null } | null) => {
        const scale = original();
        if (scale?.priceRange && scale.priceRange.minValue === scale.priceRange.maxValue) {
          const v = scale.priceRange.minValue;
          scale.priceRange = { minValue: v * 0.97, maxValue: v * 1.03 };
        }
        return scale;
      },
    });
    created.subscribeCrosshairMove((param) => {
      const time = param.time as number | undefined;
      setHovered(time === undefined ? null : (latest.current.find((c) => Date.parse(c.start) / 1000 === time) ?? null));
    });
    chart.current = created;
    series.current = candleSeries;

    // The theme: the footer's control sets data-theme, and the device's choice applies until it does.
    const repaint = () => {
      const c = palette(probe.current!);
      created.applyOptions({
        layout: { textColor: c.ink2 },
        grid: { vertLines: { color: c.rule }, horzLines: { color: c.rule } },
        rightPriceScale: { borderColor: c.rule },
        timeScale: { borderColor: c.rule },
        crosshair: { vertLine: { color: c.ink2, labelBackgroundColor: c.ink }, horzLine: { color: c.ink2, labelBackgroundColor: c.ink } },
      });
      candleSeries.applyOptions({ upColor: c.sheet, downColor: c.ink, borderUpColor: c.ink, borderDownColor: c.ink, wickUpColor: c.ink, wickDownColor: c.ink });
    };
    const observer = new MutationObserver(repaint);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const device = window.matchMedia("(prefers-color-scheme: dark)");
    device.addEventListener("change", repaint);
    return () => {
      observer.disconnect();
      device.removeEventListener("change", repaint);
      created.remove();
      chart.current = null;
      series.current = null;
      drawn.current = [];
    };
  }, []);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const before = drawn.current;
    // A live update only changes the forming candle or adds the next: drawn in place, the view stays where the reader left it.
    const tail = before.length && candles.length >= before.length && candles.slice(0, before.length - 1).every((c, i) => c === before[i]);
    if (tail) {
      for (const c of candles.slice(before.length - 1)) s.update(barOf(c));
    } else {
      s.setData(candles.map(barOf));
      chart.current?.timeScale().applyOptions({ barSpacing: CHART_CANDLE_SPACING_PX });
      chart.current?.timeScale().scrollToRealTime();
    }
    drawn.current = candles;
  }, [candles]);

  const shown = hovered ?? candles.at(-1) ?? null;
  return (
    <div className={styles.chartFrame}>
      <span ref={probe} hidden />
      <div ref={box} className={styles.chart} role="img" aria-label="Price chart, one candle per period" />
      <p className={styles.legend} aria-live="off">
        {shown && (
          <>
            <span>{formatDate(new Date(shown.start))}</span>
            <span>
              Open <b>{formatPrice(Number(shown.open))}</b>
            </span>
            <span>
              High <b>{formatPrice(Number(shown.high))}</b>
            </span>
            <span>
              Low <b>{formatPrice(Number(shown.low))}</b>
            </span>
            <span>
              Close <b>{formatPrice(Number(shown.close))}</b>
            </span>
            <span>
              {formatInteger(shown.trades)} {shown.trades === 1 ? "trade" : "trades"}
            </span>
          </>
        )}
      </p>
    </div>
  );
}
