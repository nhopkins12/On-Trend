import React, { useLayoutEffect, useRef } from "react";

/**
 * PillHighlight
 * - Expands from RIGHT, holds, collapses to LEFT, holds — all linear with even timing.
 * - Uppercase, Helvetica Neue stack, small caps look.
 * - Uses CSS variables so the pill tracks the measured text width exactly.
 *
 * Props:
 *   text?: string            (default: "loading")
 *   durationMs?: number      (default: 4000)
 *   fontSizePx?: number      (default: 24)
 *   letterSpacingEm?: number (default: 0.15)
 *   pillColor?: string       (default: "#22c55e")
 *   pillHeightEm?: number    (default: 1.4)
 */
export default function PillHighlight({
  text = "loading",
  durationMs = 4000,
  fontSizePx = 24,
  letterSpacingEm = 0.15,
  pillColor = "#22c55e",
  pillHeightEm = 1.4,
  className = "",
  style = {},
}) {
  const loaderRef = useRef(null);
  const baseRef = useRef(null);

  // Measure the rendered width (accounts for font, letter-spacing, etc.)
  const measure = () => {
    const loader = loaderRef.current;
    const base = baseRef.current;
    if (!loader || !base) return;

    // Ensure the uppercase layer is identical
    const content = String(text).toUpperCase();
    if (base.textContent !== content) base.textContent = content;

    const rect = base.getBoundingClientRect();
    loader.style.setProperty("--w", `${rect.width}px`);
    loader.classList.add("animating");
  };

  useLayoutEffect(() => {
    // initial measurement after mount
    requestAnimationFrame(() => requestAnimationFrame(measure));
    // re-measure on resize
    const onResize = () => {
      const loader = loaderRef.current;
      if (!loader) return;
      loader.classList.remove("animating");
      requestAnimationFrame(() => requestAnimationFrame(measure));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, fontSizePx, letterSpacingEm, pillHeightEm]);

  // Inline CSS for keyframes (Tailwind doesn't define this animation)
  // You can move this block to your global CSS if you prefer.
  const styleTag = (
    <style>{`
      /* Even 25% phases, strictly linear */
      @keyframes clipExpandRightCollapseLeft {
        /* inset: top right bottom left */
        0%   { clip-path: inset(0 0        0 var(--w)    round var(--pill-r)); }
        25%  { clip-path: inset(0 0        0 0           round var(--pill-r)); }
        50%  { clip-path: inset(0 0        0 0           round var(--pill-r)); }
        75%  { clip-path: inset(0 var(--w) 0 0           round var(--pill-r)); }
        100% { clip-path: inset(0 var(--w) 0 0           round var(--pill-r)); }
      }
    `}</style>
  );

  // CSS variables set via style prop (so they can be dynamic)
  const vars = {
    // measured width is set later in JS: --w
    "--pill-h": `${pillHeightEm}em`,
    "--pill-r": "0.35em",
    "--pill": pillColor,
    "--shadow": "0 4px 12px rgba(72,187,120,.25)",
    "--duration": `${durationMs}ms`,
  };

  return (
    <>
      {styleTag}
      <div
        ref={loaderRef}
        className={`relative inline-block isolate uppercase leading-none font-[600] ${className}`}
        style={{
          ...vars,
          fontFamily: `"Helvetica Neue", Helvetica, Arial, sans-serif`,
          letterSpacing: `${letterSpacingEm}em`,
          fontSize: `${fontSizePx}px`,
          ...style,
        }}
      >
        {/* Base dark text (in normal flow to set height) */}
        <span ref={baseRef} className="relative z-[1] text-[#0f172a] whitespace-nowrap">
          {String(text).toUpperCase()}
        </span>

        {/* White highlight copy (absolutely positioned) */}
        <span
          className="absolute left-0 top-0 z-[1] text-white whitespace-nowrap"
          style={{
            clipPath: "inset(0 0 0 var(--w) round var(--pill-r))",
            animation:
              "clipExpandRightCollapseLeft var(--duration) linear infinite",
          }}
          aria-hidden
        >
          {String(text).toUpperCase()}
        </span>

        {/* Green pill behind the text; full width, clip-path animated */}
        <div
          className="absolute left-0 top-1/2 z-0 -translate-y-1/2"
          style={{
            width: "var(--w)",
            height: "var(--pill-h)",
            background: "var(--pill)",
            borderRadius: "var(--pill-r)",
            boxShadow: "var(--shadow)",
            clipPath: "inset(0 0 0 var(--w) round var(--pill-r))",
            animation:
              "clipExpandRightCollapseLeft var(--duration) linear infinite",
          }}
          aria-hidden
        />
      </div>
    </>
  );
}
