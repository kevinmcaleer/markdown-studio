import { describe, expect, it } from "vitest";
import { baseOf, toActive } from "./activeVoice";

const active = (sentence: string, phrase: string) => {
  const from = sentence.indexOf(phrase);
  return toActive(sentence, from, from + phrase.length);
};

describe("toActive", () => {
  it("moves the doer to the front in the past tense", () => {
    expect(active("The code was written by Kev.", "was written")).toBe("Kev wrote the code.");
    expect(active("The servos were calibrated by the script.", "were calibrated")).toBe("The script calibrated the servos.");
    expect(active("The case was printed by me in PLA.", "was printed")).toBe("I printed the case in PLA.");
  });

  it("keeps present, perfect and modal tenses and agrees with the doer", () => {
    expect(active("The motor is driven by a Pico.", "is driven")).toBe("A Pico drives the motor.");
    expect(active("The legs are moved by four servos.", "are moved")).toBe("Four servos move the legs.");
    expect(active("The board has been tested by the team and me.", "been tested")).toBe("The team and I have tested the board.");
    expect(active("It has been used by Kev.", "been used")).toBe("Kev has used it.");
    expect(active("The parts will be bought by you.", "be bought")).toBe("You will buy the parts.");
  });

  it("keeps not and adverbs", () => {
    expect(active("The bug was quickly fixed by Sam.", "was quickly fixed")).toBe("Sam quickly fixed the bug.");
    expect(active("The code wasn't checked by anyone.", "wasn't checked")).toBe("Anyone did not check the code.");
    expect(active("The board is not powered by USB.", "is not powered")).toBe("USB does not power the board.");
  });

  it("keeps an adverb after the verb", () => {
    expect(active("The information was presented badly by most sites.", "was presented")).toBe("Most sites presented the information badly.");
  });

  it("keeps the clause before it, and relative clauses", () => {
    expect(active("Last week, the robot was assembled by us.", "was assembled")).toBe("Last week, we assembled the robot.");
    expect(active("The code that was written by Kev is great.", "was written")).toBe("The code that Kev wrote is great.");
  });

  it("gives nothing when the sentence doesn't say who did it", () => {
    expect(active("The code was written last year.", "was written")).toBeNull();
    expect(active("The way the information is presented bugs me.", "is presented")).toBeNull();
  });
});

describe("baseOf", () => {
  it("finds the base form of regular and irregular verbs", () => {
    const pairs: [string, string][] = [
      ["stored", "store"], ["created", "create"], ["stopped", "stop"], ["tried", "try"], ["powered", "power"],
      ["presented", "present"], ["used", "use"], ["changed", "change"], ["handled", "handle"], ["placed", "place"],
      ["printed", "print"], ["controlled", "control"], ["developed", "develop"], ["written", "write"], ["edited", "edit"],
      ["designed", "design"], ["mounted", "mount"], ["configured", "configure"], ["soldered", "solder"], ["programmed", "program"],
    ];
    for (const [p, b] of pairs) expect(baseOf(p), p).toBe(b);
  });
});
