/** Hand-picked accent swatches per script color, tuned to read well on both
 * light and dark backgrounds without needing separate theme variants. */
export interface Swatch {
  solid: string; // ring stroke / icon
  soft: string; // translucent background wash
  text: string; // text-on-soft
}

const PALETTE: Record<string, Swatch> = {
  violet: { solid: "#7c6cf6", soft: "rgba(124,108,246,0.14)", text: "#7c6cf6" },
  sky: { solid: "#38bdf8", soft: "rgba(56,189,248,0.14)", text: "#38bdf8" },
  emerald: { solid: "#34d399", soft: "rgba(52,211,153,0.14)", text: "#34d399" },
  amber: { solid: "#fbbf24", soft: "rgba(251,191,36,0.16)", text: "#fbbf24" },
  rose: { solid: "#fb7185", soft: "rgba(251,113,133,0.14)", text: "#fb7185" },
  cyan: { solid: "#22d3ee", soft: "rgba(34,211,238,0.14)", text: "#22d3ee" },
  fuchsia: { solid: "#e879f9", soft: "rgba(232,121,249,0.14)", text: "#e879f9" },
  lime: { solid: "#a3e635", soft: "rgba(163,230,53,0.16)", text: "#a3e635" },
};

const FALLBACK: Swatch = PALETTE.violet;

export function swatchFor(color: string): Swatch {
  return PALETTE[color] ?? FALLBACK;
}

export const COLOR_NAMES = Object.keys(PALETTE);
