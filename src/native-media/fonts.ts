import { GlobalFonts } from "@napi-rs/canvas";

// Inter for Latin like the media page, then whatever the host has for other
// scripts and emoji: the Noto families in the Docker image, the system ones on
// macOS. Skia falls back glyph by glyph along this list.
const fallbackFamilies = [
  "Noto Sans",
  "Noto Sans CJK JP",
  "Noto Sans CJK KR",
  "Noto Sans CJK SC",
  "Noto Sans CJK TC",
  "Noto Sans Arabic",
  "Noto Sans Hebrew",
  "Noto Sans Thai",
  "Noto Sans Devanagari",
  "Hiragino Sans",
  "PingFang SC",
  "Apple SD Gothic Neo",
  "WenQuanYi Zen Hei",
  "DejaVu Sans",
  "Noto Color Emoji",
  "Apple Color Emoji",
];

let fontStack: string | undefined;
export function fonts() {
  if (fontStack) return fontStack;
  for (const weight of [600, 700])
    try {
      GlobalFonts.registerFromPath(
        Bun.resolveSync(
          `@fontsource/inter/files/inter-latin-${weight}-normal.woff2`,
          import.meta.dir,
        ),
        "Inter",
      );
    } catch {}
  const available = fallbackFamilies.filter((family) =>
    GlobalFonts.has(family),
  );
  fontStack = ["Inter", ...available]
    .map((family) => `"${family}"`)
    .concat("sans-serif")
    .join(", ");
  return fontStack;
}
