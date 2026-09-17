/**
 * Script detection for lyric text. Pure string work: no DOM, no host state.
 *
 * Romanization only makes sense for lines written in a non-Latin script, and
 * the translation providers want a source language hint, so both questions are
 * answered here from Unicode script properties rather than a language model.
 */

/**
 * Latin and Common (digits, punctuation, spaces, musical symbols) cover every
 * script that already reads as romanized text, so anything outside them means
 * the line still needs transliterating.
 */
const NON_LATIN = /[^\p{Script_Extensions=Latin}\p{Script_Extensions=Common}]/u;

/** True when the text uses a script that romanization would help with. */
export function containsNonLatin(text: string) {
  return NON_LATIN.test(text);
}

/**
 * Ordered because scripts overlap: Japanese mixes Han with kana, so kana has to
 * win before Han claims the line for Chinese.
 */
const SCRIPT_LANGUAGES = [
  [/\p{Script=Hiragana}|\p{Script=Katakana}/u, "ja"],
  [/\p{Script=Hangul}/u, "ko"],
  [/\p{Script=Han}/u, "zh"],
  [/\p{Script=Cyrillic}/u, "ru"],
  [/\p{Script=Devanagari}/u, "hi"],
  [/\p{Script=Arabic}/u, "ar"],
  [/\p{Script=Thai}/u, "th"],
  [/\p{Script=Greek}/u, "el"],
  [/\p{Script=Hebrew}/u, "he"],
  [/\p{Script=Bengali}/u, "bn"],
  [/\p{Script=Tamil}/u, "ta"],
  [/\p{Script=Telugu}/u, "te"],
  [/\p{Script=Malayalam}/u, "ml"],
  [/\p{Script=Kannada}/u, "kn"],
  [/\p{Script=Gujarati}/u, "gu"],
  [/\p{Script=Gurmukhi}/u, "pa"],
  [/\p{Script=Sinhala}/u, "si"],
  [/\p{Script=Myanmar}/u, "my"],
  [/\p{Script=Georgian}/u, "ka"],
  [/\p{Script=Khmer}/u, "km"],
  [/\p{Script=Lao}/u, "lo"],
] as const;

export type NonLatinLanguage = (typeof SCRIPT_LANGUAGES)[number][1];

/** The language a non-Latin line is most likely written in, or null. */
export function detectNonLatinLanguage(text: string): NonLatinLanguage | null {
  for (const [script, lang] of SCRIPT_LANGUAGES)
    if (script.test(text)) return lang;
  return null;
}
