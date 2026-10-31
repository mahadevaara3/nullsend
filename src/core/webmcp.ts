// WebMCP: lets an AI agent in the browser call this page's tools.
// https://developer.chrome.com/docs/ai/webmcp/imperative-api
//
// Tools only work on files the person has already dropped on the page. Inputs
// and results are JSON, so a file never passes through the agent or its model;
// only the summaries returned here do. That is also why findings are reported
// as categories ("GPS location") unless the agent asks for the values.

export interface PageTool {
  name: string;
  title: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  /** Downloads a file, or changes what will be downloaded. */
  consequential?: boolean;
  readOnly?: boolean;
  execute: (input: Record<string, any>) => Promise<unknown> | unknown;
}

interface ModelContext {
  registerTool(tool: object, options?: { signal?: AbortSignal }): unknown;
}

// The API moved from navigator to document in mid-2026; Chrome still has both in some versions.
const context = (): ModelContext | undefined =>
  (document as unknown as { modelContext?: ModelContext }).modelContext
  ?? (navigator as unknown as { modelContext?: ModelContext }).modelContext;

export const NO_FILE = 'No file is loaded. Ask the user to drop a file on the page (agents cannot hand files to this page, so files never pass through the model).';

export function registerTools(tools: PageTool[]) {
  const mc = context();
  if (!mc?.registerTool) return;
  for (const t of tools) {
    void Promise.resolve(mc.registerTool({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      annotations: { readOnlyHint: !!t.readOnly, consequentialHint: !!t.consequential },
      execute: async (raw: unknown) => {
        // Older Chrome versions passed the input as a JSON string.
        const input = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw ?? {});
        try {
          const out = await t.execute(input as Record<string, any>);
          return typeof out === 'string' ? out : JSON.stringify(out, null, 1);
        } catch (e) {
          return `Error: ${(e as Error).message}`;
        }
      },
    })).catch((e) => console.warn(`WebMCP: could not register ${t.name}`, e));
  }
}

/** "Author: Jane Doe" becomes "Author" unless the agent asked for values. */
export const category = (finding: string, showValues: boolean) => (showValues ? finding : finding.split(':')[0]);

export const SHOW_VALUES = {
  show_values: {
    type: 'boolean',
    description: 'Include the actual values (coordinates, names, serial numbers). Default false: only the kinds of data found are returned, so personal details are not sent to the model. Only set true if the user asks to see them.',
  },
};
