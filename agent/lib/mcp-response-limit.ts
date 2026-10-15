export class McpResponseTooLargeError extends Error {
  constructor(maximumBytes: number) {
    super(`MCP response exceeded ${maximumBytes} bytes.`);
    this.name = "McpResponseTooLargeError";
  }
}

