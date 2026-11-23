// A run that asked instead of acting: the agent stopped to put a question to the user, having changed nothing and not
// done what was asked. In a headless run nobody answers, so the run ends there. That is neither a pass nor a fail: it is
// its own outcome, `asked`, decided here from the run's answer and the world it left, never from a task's checks.
import type { Check } from "../core/tool.ts";

/**
 * A question that offers more instead of asking for something the agent needs: "Want me to import these?", "Would you
 * like me to draft the orders?", "Should I tag the inactive ones too?", "Anything else?". Read at the start of the
 * sentence and of its last clause (after its last colon or comma), after an opening "so", "and", "if you like" and the like.
 */
const OFFER = new RegExp(
  String.raw`^(?:(?:so|and|or|also|then|otherwise|alternatively|if so|if (?:you'd|you would) like|if you like|if you want|if that helps)[,\s]+)*(?:` +
    [
      String.raw`(?:do you |would you )?want me to\b`,
      String.raw`would you like me to\b`,
      String.raw`(?:do|would) you (?:want|like) (?:me|the|a|an|more|any|it|that|this|them|those|these|to see)\b`,
      String.raw`want (?:that|this|it|them|those|these|the|a|an|more|any|to see)\b`,
      String.raw`(?:shall|should|can|could|may) i (?:also|help)\b`,
      String.raw`(?:is there )?anything else\b`,
      String.raw`need (?:anything|something|more)\b`,
      String.raw`(?:does|would|will) (?:that|this|it) help\b`,
      String.raw`(?:how|what) about\b`,
    ].join("|") +
    ")",
  "i",
);
/** A question about doing more of the same: "...the inactive ones too?" */
const MORE = /\b(?:too|as well)\?$/i;

/** Text the model did not write as a question to the user: code, link targets, quotes, headings and table rows. */
function prose(answer: string): string[] {
  return answer
    .replaceAll("’", "'").replaceAll("“", '"').replaceAll("”", '"')
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, "code")
    .replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .split("\n")
    .filter((l) => !/^\s*(?:#|>|\|)/.test(l))
    .map((l) => l.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, "").replace(/[*_]{1,3}/g, "").trim())
    .filter(Boolean);
}

const SENTENCE_END = /(?<=[.!?]["')\]]*)\s+(?=\S)/;

/** Whether a question only offers more. */
export function isOffer(question: string): boolean {
  const q = question.trim();
  const heads = [q, q.slice(q.lastIndexOf(":") + 1), q.slice(q.lastIndexOf(",") + 1)].map((h) => h.trim());
  return MORE.test(q) || heads.some((h) => OFFER.test(h));
}

/**
 * The first question the answer puts to the user, or null: a sentence of its prose that ends in a question mark and
 * does not only offer more (see `isOffer`). "Which payment method should I use: ACH, Check or Cash?" and "Should I
 * deactivate it?" ask; "Want me to import these?" offers.
 */
export function questionOf(answer: string): string | null {
  for (const line of prose(answer)) {
    for (const sentence of line.split(SENTENCE_END)) {
      const s = sentence.replace(/["')\]]+$/, "").trim();
      if (s.endsWith("?") && !isOffer(s)) return s.length > 300 ? `${s.slice(0, 297)}...` : s;
    }
  }
  return null;
}

/**
 * The question a run put to the user instead of acting, or null when it did not ask instead of acting. It did when all
 * three hold: it left the world exactly as it found it, the task's required checks did not all pass, and its answer
 * puts a question to the user (`questionOf`). A run whose checks all pass is a pass, whatever it asks or offers.
 */
export function askedInstead(run: { answer: string; checks: Check[]; worldChanged: boolean }): string | null {
  if (run.worldChanged || run.checks.filter((c) => c.required !== false).every((c) => c.pass)) return null;
  return questionOf(run.answer);
}
