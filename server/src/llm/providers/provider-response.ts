export function isProviderRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function parseProviderJson(
  response: Response,
  provider: string,
): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new Error(`${provider} returned an invalid response.`);
  }
}

export function invalidProviderResponse(provider: string): never {
  throw new Error(`${provider} returned an invalid response.`);
}
