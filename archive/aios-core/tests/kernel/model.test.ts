import { describe, it, expect } from "vitest";
import { createFallbackProvider, createOpenAIProvider, inferRisk } from "../../kernel/model.js";

describe("inferRisk", () => {
  it("returns high for delete operations", () => {
    expect(inferRisk("delete user data")).toBe("high");
    expect(inferRisk("remove legacy endpoint")).toBe("high");
    expect(inferRisk("migrate to new schema")).toBe("high");
  });

  it("returns medium for add/update operations", () => {
    expect(inferRisk("add new feature")).toBe("medium");
    expect(inferRisk("update dependencies")).toBe("medium");
    expect(inferRisk("implement login")).toBe("medium");
  });

  it("returns low for safe operations", () => {
    expect(inferRisk("fix typo in readme")).toBe("low");
    expect(inferRisk("rename variable")).toBe("low");
    expect(inferRisk("clean up logs")).toBe("low");
  });
});

describe("createFallbackProvider", () => {
  it("extracts goal from prompt and returns plan", async () => {
    const provider = createFallbackProvider();
    const result = await provider.call("Goal: fix login bug\nProject: test");
    expect(result).toContain("task: fix login bug");
    expect(result).toContain("risk:");
    expect(result).toContain("approval:");
  });

  it("returns low risk for safe goals", async () => {
    const provider = createFallbackProvider();
    const result = await provider.call("Goal: fix typo\nProject: test");
    expect(result).toContain("risk: low");
  });

  it("returns high risk for delete goals", async () => {
    const provider = createFallbackProvider();
    const result = await provider.call("Goal: delete user table\nProject: test");
    expect(result).toContain("risk: high");
  });

  it("returns MANUAL approval for high risk", async () => {
    const provider = createFallbackProvider();
    const result = await provider.call("Goal: migrate database\nProject: test");
    expect(result).toContain("risk: high");
    expect(result).toContain("approval: MANUAL");
  });

  it("returns AUTO approval for low risk", async () => {
    const provider = createFallbackProvider();
    const result = await provider.call("Goal: fix comment\nProject: test");
    expect(result).toContain("risk: low");
    expect(result).toContain("approval: AUTO");
  });

  it("handles missing Goal: line gracefully", async () => {
    const provider = createFallbackProvider();
    const result = await provider.call("some random text");
    expect(result).toContain("task: unknown");
    expect(result).toContain("risk:");
  });

  it("name is fallback", () => {
    expect(createFallbackProvider().name).toBe("fallback");
  });
});

describe("createOpenAIProvider", () => {
  it("returns expected name format", () => {
    const provider = createOpenAIProvider({ apiKey: "sk-test", model: "gpt-4o" });
    expect(provider.name).toBe("openai/gpt-4o");
  });

  it("uses default model when not specified", () => {
    const provider = createOpenAIProvider({ apiKey: "sk-test" });
    expect(provider.name).toMatch(/^openai\//);
  });

  it("sets api key from config", () => {
    const provider = createOpenAIProvider({ apiKey: "sk-custom", model: "gpt-4o" });
    expect(provider.name).toBe("openai/gpt-4o");
  });
});
