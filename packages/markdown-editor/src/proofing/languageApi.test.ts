import { afterEach, describe, expect, it, vi } from "vitest";
import { configureLanguageApi, FEATURES_RETRY_MS, languageFeatures, type LanguageRequest } from "./languageApi";
import { languageNote } from "./useProofing";

const failing = (status: number): LanguageRequest => () => Promise.reject(Object.assign(new Error(String(status)), { status }));

describe("language features", () => {
  afterEach(() => {
    configureLanguageApi(null);
    vi.useRealTimers();
  });

  // Runs a features check, letting its one retry happen straight away.
  const settle = async () => {
    vi.useFakeTimers();
    const pending = languageFeatures();
    await vi.advanceTimersByTimeAsync(FEATURES_RETRY_MS);
    vi.useRealTimers();
    return pending;
  };

  it("says why there's nothing: no server, can't reach it, or signed out", async () => {
    configureLanguageApi(null);
    expect((await languageFeatures()).unavailable).toBe("none");
    configureLanguageApi(failing(0));
    expect((await settle()).unavailable).toBe("offline");
    configureLanguageApi(failing(502));
    expect((await settle()).unavailable).toBe("offline");
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
    expect((await settle()).lookup).toBe(false);
    expect(calls).toBe(2);
    up = true;
    expect(await languageFeatures()).toEqual({ lookup: true, grammar: true, translate: false });
    await languageFeatures();
    expect(calls).toBe(3);
  });

  it("rides out one dropped request instead of saying it's offline", async () => {
    let calls = 0;
    configureLanguageApi(<T>() => {
      calls++;
      return calls === 1 ? Promise.reject(Object.assign(new Error("blip"), { status: 0 })) : Promise.resolve({ lookup: true, grammar: true, translate: false } as T);
    });
    const f = await settle();
    expect(f.unavailable).toBeUndefined();
    expect(f.lookup).toBe(true);
    expect(calls).toBe(2);
  });

  it("doesn't retry when it wants you signed in", async () => {
    let calls = 0;
    configureLanguageApi(<T>() => {
      calls++;
      return Promise.reject(Object.assign(new Error("401"), { status: 401 })) as Promise<T>;
    });
    expect((await languageFeatures()).unavailable).toBe("signin");
    expect(calls).toBe(1);
  });

  it("puts a reason in the menu only when the server can't help", () => {
    expect(languageNote({ lookup: false, grammar: false, translate: false, unavailable: "offline" })).toMatch(/Spelling still works.*can't be reached/);
    expect(languageNote({ lookup: false, grammar: false, translate: false, unavailable: "signin" })).toMatch(/Sign in/);
    expect(languageNote({ lookup: false, grammar: false, translate: false, unavailable: "none" })).toBe("");
    expect(languageNote({ lookup: true, grammar: true, translate: false })).toBe("");
  });
});
