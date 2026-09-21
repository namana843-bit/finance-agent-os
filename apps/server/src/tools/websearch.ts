// ============================================================================
// Web Search Tool
// Calls a search API to find information on the web
// ============================================================================

import type { ToolDefinition } from "@finance/shared";

interface DuckDuckGoResponse {
  Abstract?: string;
  AbstractText?: string;
  RelatedTopics?: Array<string | { Text?: string }>;
}

export function websearchTool(): ToolDefinition {
  return {
    id: "web_search",
    name: "Web Search",
    description: "Search the web for information on a query",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              snippet: { type: "string" },
            },
          },
        },
      },
    },
    permissions: { required: false },
  };
}

export async function executeWebsearch(input: Record<string, unknown>): Promise<{
  query: string;
  results: { title: string; url: string; snippet: string }[];
}> {
  const query = String(input.query);
  // Use DuckDuckGo instant answer API (no API key required)
  const response = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(
      query
    )}&format=json&no_redirect=1&no_html=1`
  );
  const data = await response.json() as DuckDuckGoResponse;

  const results: { title: string; url: string; snippet: string }[] = [];

  if (data.RelatedTopics) {
    for (const topic of data.RelatedTopics) {
      const text = typeof topic === "string" ? topic : topic.Text;
      if (text) {
        // Try to parse title and URL from the topic text
        const match = text.match(/^\[([^\]]+)\]\(([^)]+)\)/);
        if (match) {
          results.push({ title: match[1], url: match[2], snippet: text });
        } else {
          results.push({ title: text, url: "", snippet: text });
        }
      }
    }
  }

  if (results.length === 0) {
    results.push({
      title: query,
      url: "",
      snippet: data.Abstract ? data.Abstract : data.AbstractText || `Search results for: ${query}`,
    });
  }

  return { query, results };
}