import { expect, test } from "bun:test";
import { architectureDiff, graphProblems } from "../src/domain/architecture-diff.ts";
import type { ArchitectureGraph } from "../src/domain/architecture.ts";
import { parseGithubRepoUrl } from "../src/services/repo-url.ts";

const before: ArchitectureGraph = {
  nodes: [{ id: "ticket", label: "Ticket", kind: "data", col: 0, row: 0 }],
  edges: [],
};
const after: ArchitectureGraph = {
  nodes: [...before.nodes, { id: "classify", label: "classify()", kind: "function", col: 1, row: 0 }],
  edges: [{ from: "ticket", to: "classify", rel: "flows_to" }],
};

test("architecture diff reports only what the stage adds", () => {
  expect(architectureDiff(before, after)).toEqual({ newNodes: ["classify"], newEdges: ["ticket>classify:flows_to"] });
  expect(architectureDiff(after, after)).toEqual({ newNodes: [], newEdges: [] });
});

test("graph problems catch dangling edges", () => {
  expect(graphProblems(after)).toEqual([]);
  expect(graphProblems({ ...after, edges: [{ from: "ticket", to: "ghost", rel: "calls" }] })).toEqual(["edge to unknown node ghost"]);
});

test("accepts canonical public GitHub repo URLs", () => {
  expect(parseGithubRepoUrl("https://github.com/marcelotaparelli/ops-triage-ai")).toEqual({
    owner: "marcelotaparelli",
    name: "ops-triage-ai",
    url: "https://github.com/marcelotaparelli/ops-triage-ai",
  });
  expect(parseGithubRepoUrl("https://github.com/a/b.git")?.name).toBe("b");
  expect(parseGithubRepoUrl("https://github.com/a/b/")?.name).toBe("b");
});

test("rejects anything that could reach another host or path (anti-SSRF)", () => {
  for (const url of [
    "http://github.com/a/b",
    "https://github.com.evil.com/a/b",
    "https://evil.com/github.com/a/b",
    "https://user:pass@github.com/a/b",
    "https://github.com:8443/a/b",
    "https://github.com/a/b?x=1",
    "https://github.com/a/b#x",
    "https://github.com/a/b/tree/main",
    "https://github.com/a/..",
    "https://127.0.0.1/a/b",
    "file:///etc/passwd",
    "git@github.com:a/b.git",
    "https://github.com/" + "a".repeat(250) + "/b",
  ]) {
    expect(parseGithubRepoUrl(url)).toBeUndefined();
  }
});
