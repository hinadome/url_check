"use client";

import type {
  NavigationTimingSnapshot,
  ResourceTiming,
} from "@/lib/types";

export type WaterfallPhase = {
  key: string;
  label: string;
  start: number;
  end: number;
  colorClass: string;
};

function isValidRange(start: number, end: number): boolean {
  return start >= 0 && end >= 0 && end >= start;
}

export function buildResourceWaterfallPhases(
  timing: ResourceTiming,
): WaterfallPhase[] {
  const phases: WaterfallPhase[] = [];

  const push = (
    key: string,
    label: string,
    start: number,
    end: number,
    colorClass: string,
  ) => {
    if (isValidRange(start, end)) {
      phases.push({ key, label, start, end, colorClass });
    }
  };

  push(
    "dns",
    "DNS",
    timing.domainLookupStart,
    timing.domainLookupEnd,
    "timing-bar--dns",
  );

  if (
    isValidRange(timing.connectStart, timing.connectEnd) &&
    timing.secureConnectionStart >= timing.connectStart &&
    timing.secureConnectionStart <= timing.connectEnd
  ) {
    push(
      "connect",
      "Connect",
      timing.connectStart,
      timing.secureConnectionStart,
      "timing-bar--connect",
    );
    push(
      "tls",
      "TLS",
      timing.secureConnectionStart,
      timing.connectEnd,
      "timing-bar--tls",
    );
  } else {
    push(
      "connect",
      "Connect",
      timing.connectStart,
      timing.connectEnd,
      "timing-bar--connect",
    );
  }

  push(
    "wait",
    "Waiting (TTFB)",
    timing.requestStart,
    timing.responseStart,
    "timing-bar--wait",
  );
  push(
    "download",
    "Content download",
    timing.responseStart,
    timing.responseEnd,
    "timing-bar--download",
  );

  return phases;
}

export function buildNavigationWaterfallPhases(
  nav: NavigationTimingSnapshot,
): WaterfallPhase[] {
  const phases: WaterfallPhase[] = [];

  const push = (
    key: string,
    label: string,
    start: number,
    end: number,
    colorClass: string,
  ) => {
    if (isValidRange(start, end)) {
      phases.push({ key, label, start, end, colorClass });
    }
  };

  push(
    "dns",
    "DNS",
    nav.domainLookupStart,
    nav.domainLookupEnd,
    "timing-bar--dns",
  );

  if (
    isValidRange(nav.connectStart, nav.connectEnd) &&
    nav.secureConnectionStart >= nav.connectStart &&
    nav.secureConnectionStart <= nav.connectEnd
  ) {
    push(
      "connect",
      "Connect",
      nav.connectStart,
      nav.secureConnectionStart,
      "timing-bar--connect",
    );
    push(
      "tls",
      "TLS",
      nav.secureConnectionStart,
      nav.connectEnd,
      "timing-bar--tls",
    );
  } else {
    push(
      "connect",
      "Connect",
      nav.connectStart,
      nav.connectEnd,
      "timing-bar--connect",
    );
  }

  push(
    "wait",
    "Waiting (TTFB)",
    nav.requestStart,
    nav.responseStart,
    "timing-bar--wait",
  );
  push(
    "download",
    "Content download",
    nav.responseStart,
    nav.responseEnd,
    "timing-bar--download",
  );
  push(
    "dom",
    "DOM interactive → complete",
    nav.domInteractive,
    nav.domComplete,
    "timing-bar--dom",
  );
  push(
    "load",
    "Load event",
    nav.loadEventStart,
    nav.loadEventEnd,
    "timing-bar--load",
  );

  return phases;
}

function formatMs(value: number): string {
  if (Number.isInteger(value)) return `${value} ms`;
  return `${value.toFixed(1)} ms`;
}

function scaleEnd(phases: WaterfallPhase[], fallbackEnd: number): number {
  let max = fallbackEnd >= 0 ? fallbackEnd : 0;
  for (const phase of phases) {
    if (phase.end > max) max = phase.end;
  }
  return max > 0 ? max : 1;
}

type TimingWaterfallProps = {
  title: string;
  phases: WaterfallPhase[];
  /** Preferred total duration (e.g. responseEnd); phases may extend it */
  totalMs?: number;
};

export function TimingWaterfall({
  title,
  phases,
  totalMs = -1,
}: TimingWaterfallProps) {
  if (phases.length === 0) {
    return null;
  }

  const total = scaleEnd(phases, totalMs);

  return (
    <div className="timing-waterfall" aria-label={title}>
      <div className="timing-waterfall-header">
        <span className="timing-waterfall-title">{title}</span>
        <span className="timing-waterfall-total muted">
          Scale 0 – {formatMs(total)}
        </span>
      </div>

      <div className="timing-waterfall-stacked" aria-hidden={false}>
        <div className="timing-waterfall-track timing-waterfall-track--stacked">
          {phases.map((phase) => {
            const left = (phase.start / total) * 100;
            const width = Math.max(
              ((phase.end - phase.start) / total) * 100,
              phase.end === phase.start ? 0.4 : 0.15,
            );
            return (
              <div
                key={`stack-${phase.key}`}
                className={`timing-waterfall-bar ${phase.colorClass}`}
                style={{ left: `${left}%`, width: `${width}%` }}
                title={`${phase.label}: ${formatMs(phase.end - phase.start)} (${formatMs(phase.start)} → ${formatMs(phase.end)})`}
              />
            );
          })}
        </div>
      </div>

      <ul className="timing-waterfall-legend">
        {phases.map((phase) => (
          <li key={`legend-${phase.key}`}>
            <span
              className={`timing-waterfall-swatch ${phase.colorClass}`}
              aria-hidden
            />
            {phase.label}
          </li>
        ))}
      </ul>

      <div className="timing-waterfall-rows">
        {phases.map((phase) => {
          const left = (phase.start / total) * 100;
          const width = Math.max(
            ((phase.end - phase.start) / total) * 100,
            phase.end === phase.start ? 0.4 : 0.15,
          );
          const duration = phase.end - phase.start;
          return (
            <div key={phase.key} className="timing-waterfall-row">
              <div className="timing-waterfall-label">{phase.label}</div>
              <div className="timing-waterfall-track">
                <div
                  className={`timing-waterfall-bar ${phase.colorClass}`}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${formatMs(phase.start)} → ${formatMs(phase.end)}`}
                />
              </div>
              <div className="timing-waterfall-duration">{formatMs(duration)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
