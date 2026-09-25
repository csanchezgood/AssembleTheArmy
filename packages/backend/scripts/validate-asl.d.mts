export interface AslValidation {
  ok: boolean;
  errors: string[];
  definition: unknown;
}
export const REQUIRED_PLACEHOLDERS: string[];
export const DEFAULT_ASL_PATH: string;
export function substitutePlaceholders(text: string): { text: string; errors: string[] };
export function validateAsl(text: string): AslValidation;
export function validateAslFile(path?: string): Promise<AslValidation>;
