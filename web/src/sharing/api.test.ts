import { describe, expect, it } from "vitest";
import { isLocalOnly, shareUrl } from "./api";

describe("shareUrl", () => {
  it("prefers the server's PUBLIC_URL link", () => {
    const link = { path: "/s/abc", url: "https://studio.example.com/s/abc" };
    expect(shareUrl(link, "http://0.0.0.0:8000")).toBe("https://studio.example.com/s/abc");
  });

  it("falls back to the page's origin", () => {
    expect(shareUrl({ path: "/s/abc", url: null }, "http://pi.local:8000")).toBe("http://pi.local:8000/s/abc");
  });
});

describe("isLocalOnly", () => {
  it("flags hosts nobody else can reach", () => {
    for (const host of ["0.0.0.0", "localhost", "127.0.0.1", "[::1]"]) {
      expect(isLocalOnly({ url: null }, host)).toBe(true);
    }
  });

  it("passes LAN and public hosts, and any PUBLIC_URL link", () => {
    expect(isLocalOnly({ url: null }, "192.168.1.20")).toBe(false);
    expect(isLocalOnly({ url: null }, "pi.local")).toBe(false);
    expect(isLocalOnly({ url: "https://studio.example.com/s/abc" }, "localhost")).toBe(false);
  });
});
