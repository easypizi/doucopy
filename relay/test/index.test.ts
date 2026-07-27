import { describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";

const ENV = {
  RELAY_SECRET: "e2e-secret-0123456789abcdef",
} as NodeJS.ProcessEnv;

describe("/mcp method handling", () => {
  it("returns 405 with Allow: POST on GET /mcp so stateless clients stop retrying", async () => {
    const app = buildApp(ENV);
    const res = await app.inject({ method: "GET", url: "/mcp" });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("POST");
    await app.close();
  });

  it("returns 405 on DELETE /mcp", async () => {
    const app = buildApp(ENV);
    const res = await app.inject({ method: "DELETE", url: "/mcp" });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("POST");
    await app.close();
  });
});
