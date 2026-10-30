/** Issue order, rather than completion order, decides whether a tool error was answered. */
export class TurnToolOutcomes {
  #message = 0;
  #issued = new Map<string, number>();
  #lastError = -1;
  #lastSuccess = -1;
  #lastText = -1;

  assistant(text: string, toolCallIds: readonly string[]): void {
    this.#message++;
    for (const id of toolCallIds) this.#issued.set(id, this.#message);
    if (text.trim()) this.#lastText = this.#message;
  }

  error(toolCallId?: string): void {
    this.#lastError = Math.max(this.#lastError, this.#issue(toolCallId));
  }

  success(toolCallId?: string): void {
    this.#lastSuccess = Math.max(this.#lastSuccess, this.#issue(toolCallId));
  }

  get successfulTool(): boolean { return this.#lastSuccess >= 0; }
  get unansweredError(): boolean {
    return this.#lastError >= 0 && this.#lastError >= Math.max(this.#lastSuccess, this.#lastText);
  }

  #issue(id?: string): number { return id ? this.#issued.get(id) ?? this.#message : this.#message; }
}
