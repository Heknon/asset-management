import { highlightRuns } from '@am/core';

/** Renders a «highlighted» search snippet as text (never as HTML). */
export function Highlight({ snippet, className }: { snippet: string; className?: string }) {
  return (
    <span className={className}>
      {highlightRuns(snippet).map((r, i) =>
        r.hit ? (
          <mark key={i} className="rounded-[3px] bg-warning-soft px-0.5 text-fg">
            {r.text}
          </mark>
        ) : (
          <span key={i}>{r.text}</span>
        ),
      )}
    </span>
  );
}
