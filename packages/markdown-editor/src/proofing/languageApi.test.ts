import { afterEach, describe, expect, it } from "vitest";
import { configureLanguageApi, languageFeatures, type LanguageRequest } from "./languageApi";
import { languageNote } from "./useProofing";

const failing = (status: number): LanguageRequest => () => Promise.reject(Object.assign(new Error(String(status)), { status }));

describe("language features", () => {
  afterEach(() => configureLanguageApi(null));

  it("says why there's nothing: no server, can't reach it, or signed out", async () => {
    configureLanguageApi(null);
    expect((await languageFeatures()).unavailable).toBe("none");
    configureLanguageApi(failing(0));
    expect((await languageFeatures()).unavailable).toBe("offline");
    configureLanguageApi(failing(502));
    expect((await languageFeatures()).unavailable).toBe("offline");
    configureLanguageApi(failing(401));
    expect((await languageFeatures()).unavailable).toBe("signin");
  });

  it("asks again after a failure, and keeps an answer", async () => {
    let calls = 0;
    let up = false;
    configureLanguageApi(<T>() => {
      calls++;
      return up ? Promise.resolve({ lookup: true, grammar: true, translate: false } as T) : Promise.reject(Object.assign(new Error("down"), { status: 0 }));
    });
    expect((await languageFeatures()).lookup).toBe(false);
    up = true;
    expect(await languageFeatures()).toEqual({ lookup: true, grammar: true, translate: false });
    await languageFeatures();
    expect(calls).toBe(2);
  });

  it("puts a reason in the menu only when the server can't help", () => {
    expect(languageNote({ lookup: false, grammar: false, translate: false, unavailable: "offline" })).toMatch(/can't be reached/);
    expect(languageNote({ lookup: false, grammar: false, translate: false, unavailable: "signin" })).toMatch(/Sign in/);
    expect(languageNote({ lookup: false, grammar: false, translate: false, unavailable: "none" })).toBe("");
    expect(languageNote({ lookup: true, grammar: true, translate: false })).toBe("");
  });
});
