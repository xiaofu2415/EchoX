const EXPECTED_RUNTIME_ERRORS =
  /extension context invalidated|receiving end does not exist|message port closed/i;

export function sendRuntimeMessageSafely(
  message: unknown,
  context: string
): void {
  try {
    const request = chrome.runtime.sendMessage(message);
    void request.catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      if (!EXPECTED_RUNTIME_ERRORS.test(detail)) {
        console.warn(`[${context}] Runtime message failed:`, error);
      }
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!EXPECTED_RUNTIME_ERRORS.test(detail)) {
      console.warn(`[${context}] Runtime message failed:`, error);
    }
  }
}
