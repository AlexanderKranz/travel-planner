/**
 * Spoken text of a stop card (docs/specs/city-tour-stop-info.md section 6). Pure: the UI passes translated sentences.
 * Parentheses (pronunciation, IPA, dates in brackets) are dropped before speaking only; long text is split into
 * sentence chunks because some engines cut long utterances.
 */
export type SpeechPart = { text: string; lang: string };

const MAX_CHUNK = 220;

/** Text without parenthesised asides, whitespace collapsed. */
export function speakable(text: string): string {
  let s = text;
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/\s*\([^()]*\)/g, "");
  }
  return s.replace(/\s+/g, " ").trim();
}

/** Sentence chunks of at most ~220 characters (a single longer sentence is cut on a word). */
export function chunks(text: string): string[] {
  const sentences = speakable(text).match(/[^.!?…]+[.!?…]*\s*/g) ?? [];
  const out: string[] = [];
  let cur = "";
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if ((cur + " " + s).trim().length <= MAX_CHUNK) {
      cur = (cur + " " + s).trim();
      continue;
    }
    if (cur) out.push(cur);
    if (s.length <= MAX_CHUNK) cur = s;
    else {
      let rest = s;
      while (rest.length > MAX_CHUNK) {
        const cut = rest.lastIndexOf(" ", MAX_CHUNK);
        const at = cut > 40 ? cut : MAX_CHUNK;
        out.push(rest.slice(0, at).trim());
        rest = rest.slice(at).trim();
      }
      cur = rest;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** "{n}. {name}." in the owner's language, then the text in its own language, then the fact sentences. */
export function stopSpeech(p: {
  intro: string;
  introLang: string;
  text?: string;
  textLang?: string;
  facts: string[];
  /** False when no voice exists for the text's language: the text is skipped. */
  textVoice: boolean;
}): SpeechPart[] {
  const parts: SpeechPart[] = [{ text: p.intro, lang: p.introLang }];
  if (p.text && p.textLang && p.textVoice) for (const c of chunks(p.text)) parts.push({ text: c, lang: p.textLang });
  for (const f of p.facts) parts.push({ text: f, lang: p.introLang });
  return parts;
}
